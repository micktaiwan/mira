// Filling a login from the vault, assembled: the page agent on one side, the
// `bw` read on the other, and the pure rules of login-fill.ts in between.
//
// The whole flow, once per call:
//   a tab + a profile -> the profile's vault (unmapped = refuse, the account
//   wall) -> the logins it holds, unlocking through Mira's own bubble if needed
//   -> the candidates for the page's host -> chooseLogin -> the pair goes to
//   EVERY frame of the tab -> each frame answers what it filled -> the choice is
//   remembered for that site.
//
// THE ONE RULE THAT SHAPES THIS FILE: a password crosses exactly one boundary,
// main -> the frame's isolated world, over a private ipc channel. It is never
// part of a command result, never logged, never written to disk, and never put
// into the page's own JavaScript world (which is why this is a preload agent and
// not an exec-js call). `bitwarden-login.ts` says a vault password exists only to
// be compared or written back; filling adds exactly one destination to that
// list, and this file is the whole of it.
//
// The remembered choice (userData/login-fill.json) holds no secret: a profile
// id, a site, and a vault item id — a handle that is useless without the vault.

import { ipcMain, type Session, type WebContents, type WebFrameMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { CardVault } from './bitwarden'
import type { VaultLogin } from './bitwarden-login'
import {
  candidatesForHost,
  chooseLogin,
  fillHost,
  fillSite,
  forgetFillProfile,
  lastFill,
  mergeFillReports,
  readFillMemory,
  readFrameFillReport,
  redactCandidates,
  rememberFill,
  type FillCandidate,
  type FillMemory,
  type FrameFillReport
} from './login-fill'
import {
  LOGIN_FILL_APPLY_CHANNEL,
  LOGIN_FILL_PRELOAD_SOURCE,
  LOGIN_FILL_RESULT_CHANNEL
} from './login-fill-shim'

/** What the service needs from the outside world. All injectable, so the flow is
 * unit-tested without Electron, Bitwarden or a window. */
export interface LoginFillDeps {
  /** The vault a profile reads from, or null when it is unmapped. */
  vaultFor: (profileId: string) => CardVault | null
  /** The vault's logins, WITH their passwords. Pops the master-password bubble
   * when the vault is locked, so a fill never dead-ends on "locked" — this is
   * LoginService.readLogins. */
  readLogins: (profileId: string, vault: CardVault) => Promise<VaultLogin[]>
  /** Every frame of a tab that could hold a login form. */
  framesOf: (contents: WebContents) => WebFrameMain[]
  /** The tab's current top-level url, for host matching and for the report. */
  urlOf: (contents: WebContents) => string
  /** Ask WHICH account, in Mira's own bubble, and resolve with the chosen item
   * id (null = dismissed). The one question this feature is allowed to ask: the
   * answer is not something the browser can work out (CLAUDE.md, « faire
   * travailler l'utilisateur final »). Absent = no window can ask, so an
   * ambiguous page simply answers with the list. */
  pick?: (params: {
    profileId: string
    host: string
    candidates: FillCandidate[]
  }) => Promise<string | null>
  /** How long to wait for the frames to answer, ms. */
  timeoutMs?: number
  /** Read the remembered choices. Injected so the flow is testable without
   * disk; defaults to userData/login-fill.json. */
  load?: () => FillMemory
  /** Write them back. Same reason. */
  persist?: (memory: FillMemory) => void
}

/** What a fill call answers with. Never a password, and never a candidate list
 * AND a fill at the same time: either Mira knew which account to use, or it is
 * asking. */
export interface FillOutcome {
  profileId: string
  url: string
  host: string
  /** Set when something was filled. */
  filled?: {
    id: string
    name: string
    username: string
    username_filled: boolean
    password_filled: boolean
    frames: number
    passwordFields: number
  }
  /** Set when the caller has to choose: more than one account matches. */
  candidates?: FillCandidate[]
}

/** A fill that could not happen, with a reason a human can act on. Separate from
 * a plain Error so the command layer can phrase it. */
export class LoginFillError extends Error {
  constructor(
    readonly reason: 'no-vault' | 'no-page' | 'no-match' | 'unknown-id' | 'unknown-username',
    message: string
  ) {
    super(message)
    this.name = 'LoginFillError'
  }
}

export class LoginFillService {
  private readonly file: string
  private memory: FillMemory
  private preloadPath: string | null = null
  private readonly attached = new WeakSet<Session>()
  private ipcInstalled = false
  /** token -> the frame answers collected so far. */
  private readonly pending = new Map<string, FrameFillReport[]>()
  private nextToken = 0

  constructor(
    private readonly userDataDir: string,
    private readonly deps: LoginFillDeps
  ) {
    this.file = join(userDataDir, 'login-fill.json')
    this.memory = (deps.load ?? (() => this.loadFromDisk()))()
  }

  /** Register the fill agent on a web-page session (once per session) and install
   * the ipc listener (once). Called only for a profile that HAS a vault, so an
   * unmapped profile never receives the agent. */
  attach(ses: Session): void {
    this.installIpc()
    if (this.attached.has(ses)) return
    this.attached.add(ses)
    ses.registerPreloadScript({
      id: 'mira-login-fill',
      type: 'frame',
      filePath: this.ensurePreload()
    })
  }

  /** Forget what a profile remembers (profile deleted, its data cleared). */
  forgetProfile(profileId: string): void {
    const next = forgetFillProfile(this.memory, profileId)
    if (next === this.memory) return
    this.memory = next
    this.persist()
  }

  /** The accounts that could fill the form on this tab, no passwords. Answers the
   * "show me a list" half of the feature without filling anything. */
  async candidates(params: {
    profileId: string
    contents: WebContents
  }): Promise<{ profileId: string; url: string; host: string; candidates: FillCandidate[] }> {
    const vault = this.requireVault(params.profileId)
    const url = this.deps.urlOf(params.contents)
    const host = fillHost(url)
    if (host === '') {
      throw new LoginFillError('no-page', 'not a web page — nothing to fill here')
    }
    const items = await this.deps.readLogins(params.profileId, vault)
    return {
      profileId: params.profileId,
      url,
      host,
      candidates: redactCandidates(candidatesForHost(items, host), host)
    }
  }

  /** Fill the tab's login form from the vault.
   *
   * With no `id` and no `username`, Mira fills only when the answer is not a
   * guess: one matching account, or the one chosen last time on this site.
   * Otherwise it returns the list and fills NOTHING — a wrong password typed
   * into a live form is a lockout, and asking costs one call. */
  async fill(params: {
    profileId: string
    contents: WebContents
    id?: string
    username?: string
    /** false to never open the picker: an ambiguous page answers with the list
     * instead. For a scripted caller that must not block on a window. */
    ask?: boolean
  }): Promise<FillOutcome> {
    const vault = this.requireVault(params.profileId)
    const url = this.deps.urlOf(params.contents)
    const host = fillHost(url)
    if (host === '') {
      throw new LoginFillError('no-page', 'not a web page — nothing to fill here')
    }
    const site = fillSite(host)
    const items = await this.deps.readLogins(params.profileId, vault)
    const candidates = candidatesForHost(items, host)
    const choice = chooseLogin(candidates, {
      id: params.id,
      username: params.username,
      lastUsedId: lastFill(this.memory, params.profileId, site)
    })
    let picked = choice.pick
    if (!picked && choice.reason === 'ambiguous') {
      // Ask, in Mira's own bubble, and fill with the answer. A dismissal is not
      // an error: it comes back as the list, exactly as if nothing could ask.
      const chosen =
        params.ask === false || !this.deps.pick
          ? null
          : await this.deps.pick({
              profileId: params.profileId,
              host,
              candidates: redactCandidates(candidates, host)
            })
      picked = chosen ? (candidates.find((item) => item.id === chosen) ?? null) : null
      if (!picked) {
        return {
          profileId: params.profileId,
          url,
          host,
          candidates: redactCandidates(candidates, host)
        }
      }
    }
    if (!picked) {
      // 'ok' and 'no-host' cannot reach here (pick is null, and the host was
      // checked above), but the map is exhaustive rather than cast: a new reason
      // added to chooseLogin must surface as a real refusal, not as a silent
      // "no login saved".
      const reason =
        choice.reason === 'unknown-id' || choice.reason === 'unknown-username'
          ? choice.reason
          : 'no-match'
      throw new LoginFillError(reason, this.explain(choice.reason, host, params))
    }
    const merged = await this.apply(params.contents, picked)
    // Remember only a fill that actually landed: recording a choice that filled
    // nothing would make the next call skip the list for no reason.
    if (merged.username || merged.password) {
      this.memory = rememberFill(this.memory, params.profileId, site, picked.id)
      this.persist()
    }
    return {
      profileId: params.profileId,
      url,
      host,
      filled: {
        id: picked.id,
        name: picked.name,
        username: picked.username,
        username_filled: merged.username,
        password_filled: merged.password,
        frames: merged.frames,
        passwordFields: merged.passwordFields
      }
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Hand the pair to every frame of the tab and collect what they filled. Every
   * frame is asked because a login form is often in an iframe (SSO widgets), and
   * a frame with no form simply answers that it filled nothing. */
  private async apply(
    contents: WebContents,
    login: VaultLogin
  ): Promise<{ username: boolean; password: boolean; frames: number; passwordFields: number }> {
    const token = `fill-${++this.nextToken}-${Date.now()}`
    this.pending.set(token, [])
    const frames = this.deps.framesOf(contents)
    for (const frame of frames) {
      try {
        frame.send(LOGIN_FILL_APPLY_CHANNEL, {
          token,
          username: login.username,
          password: login.password
        })
      } catch {
        // A frame that went away mid-call is not an error: the others answer.
      }
    }
    const reports = await this.collect(token, frames.length)
    return mergeFillReports(reports)
  }

  /** Wait for the frames to answer, or for the timeout. Resolves as soon as
   * every frame has answered, so the common case (one frame) costs one tick and
   * not the whole timeout. */
  private collect(token: string, expected: number): Promise<FrameFillReport[]> {
    const timeout = this.deps.timeoutMs ?? 2000
    const take = (): FrameFillReport[] => {
      const reports = this.pending.get(token) ?? []
      this.pending.delete(token)
      return reports
    }
    // The frames of a same-process page answer synchronously, so the common case
    // never arms a timer at all.
    if ((this.pending.get(token)?.length ?? 0) >= expected) return Promise.resolve(take())
    return new Promise((resolve) => {
      const done = (): void => {
        clearInterval(timer)
        clearTimeout(deadline)
        resolve(take())
      }
      const timer = setInterval(() => {
        if ((this.pending.get(token)?.length ?? 0) >= expected) done()
      }, 20)
      const deadline = setTimeout(done, timeout)
    })
  }

  /** One frame's answer. Public because the ipc listener is the only thing that
   * needs Electron in this file, and the flow has to be testable without it. */
  handleFrameReport(payload: unknown): void {
    const report = readFrameFillReport(payload)
    if (!report) return
    // A frame answering a request that already finished (or never existed) is
    // dropped: its token is gone, and counting it would corrupt a later call.
    const bucket = this.pending.get(report.token)
    if (!bucket) return
    bucket.push(report)
  }

  private installIpc(): void {
    if (this.ipcInstalled) return
    this.ipcInstalled = true
    ipcMain.on(LOGIN_FILL_RESULT_CHANNEL, (_event, payload) => this.handleFrameReport(payload))
  }

  private requireVault(profileId: string): CardVault {
    const vault = this.deps.vaultFor(profileId)
    if (!vault) {
      throw new LoginFillError('no-vault', `no card vault for profile: ${profileId}`)
    }
    return vault
  }

  private explain(
    reason: string,
    host: string,
    params: { id?: string; username?: string }
  ): string {
    if (reason === 'unknown-id') return `no login with id ${params.id} matches ${host}`
    if (reason === 'unknown-username') {
      return `no login for ${params.username} on ${host}`
    }
    return `no login saved for ${host}`
  }

  private ensurePreload(): string {
    if (this.preloadPath) return this.preloadPath
    const dir = join(this.userDataDir, 'sw-shims')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const path = join(dir, 'login-fill.js')
    writeFileSync(path, LOGIN_FILL_PRELOAD_SOURCE, 'utf8')
    return (this.preloadPath = path)
  }

  private loadFromDisk(): FillMemory {
    try {
      if (!existsSync(this.file)) return {}
      return readFillMemory(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      // A corrupt file costs the remembered choices, never a crash.
      return {}
    }
  }

  private persist(): void {
    const write = this.deps.persist
    if (write) {
      write(this.memory)
      return
    }
    try {
      if (!existsSync(this.userDataDir)) mkdirSync(this.userDataDir, { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.memory, null, 2), 'utf8')
    } catch (error) {
      console.warn('[mira] failed to write login-fill.json:', error)
    }
  }
}
