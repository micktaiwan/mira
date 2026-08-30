// Turning what a page reported into an offer to save a login, and carrying that
// offer through to the Bitwarden vault. The orchestration layer: the decisions
// are pure (login-capture.ts, bitwarden-login.ts), the CLI is
// bitwarden-service.ts, the bubble is login-prompt.ts.
//
// The flow, once per tab:
//   report (a pair, from one frame) -> merge into that tab's draft (TTL'd)
//   -> did the user actually submit? if not, keep it and stay silent
//   -> complete + plausible? (login-capture.ts)
//   -> is this profile mapped to a vault? (unmapped = silence, the account wall)
//   -> already offered this exact login this run? -> silence
//   -> already in the vault with the SAME password? -> silence
//   -> already in the vault with another password? -> "Update this login?"
//   -> the same credential, saved on another subdomain of this site? -> record
//      the address on that item, silently: nothing to decide, nothing to ask
//   -> otherwise -> "Save this login?" (or "Unlock and save" when locked)
//   -> bw create item / bw edit item, on stdin.
//
// Every collaborator is INJECTED so the whole flow is unit-tested without
// Electron, Bitwarden or a window (CLAUDE.md "tout testable").

import { ipcMain, type Session } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  loginLabel,
  loginFingerprint,
  mergeLoginFragment,
  normalizeLoginFragment,
  validateLogin,
  type LoginDraft,
  type LoginFragment,
  type ValidatedLogin
} from './login-capture'
import { LOGIN_CAPTURE_PRELOAD_SOURCE, LOGIN_FRAGMENT_CHANNEL } from './login-capture-shim'
import type { CardVault } from './bitwarden'
import type { LoginMatch, VaultLogin } from './bitwarden-login'
import { BitwardenError } from './bitwarden-service'
import type { CardPromptHandle } from './card-prompt'
import type { LoginPromptRequest } from './login-prompt'
import type { FragmentSource } from './card-capture-service'

/** What the service needs from the outside world. All injectable. */
export interface LoginCaptureDeps {
  /** The vault a profile writes to, or null when it is unmapped. */
  vaultFor: (profileId: string) => CardVault | null
  /** True when this vault already has a usable session key. */
  hasSession: (vault: CardVault) => boolean
  /** What `bw status` says. Asked BEFORE any prompt, so a vault with no account
   * logged in never gets a master-password box it cannot use. */
  vaultState: (vault: CardVault) => Promise<string>
  /** Unlock with the master password (throws BitwardenError on a bad one). */
  unlock: (vault: CardVault, password: string) => Promise<void>
  /** What the vault already holds for this login: the account itself, and/or the
   * same credential under another subdomain. Only ever called with an unlocked
   * vault. */
  findMatch: (vault: CardVault, login: ValidatedLogin) => Promise<LoginMatch>
  /** Write a new login, returning the created item id. */
  saveLogin: (vault: CardVault, login: ValidatedLogin, now: Date) => Promise<string | null>
  /** Replace an existing item's password, keeping everything else. */
  updateLogin: (vault: CardVault, existing: VaultLogin, password: string) => Promise<void>
  /** Add one address to an existing item, changing nothing else. */
  linkLogin: (vault: CardVault, existing: VaultLogin, uri: string) => Promise<void>
  /** Put the bubble up. The handle carries the eventual answer AND the way to
   * report progress in it, because unlocking + writing takes seconds of bw. */
  prompt: (profileId: string, req: LoginPromptRequest) => CardPromptHandle
  /** Flash a message in the profile's window. */
  toast: (profileId: string, message: string) => void
  /** Injected clock. */
  now: () => Date
}

/** What one report ended up doing. Returned so the tests (and the socket) can
 * assert on the whole pipeline. */
export type LoginOutcome =
  'ignored' | 'incomplete' | 'known' | 'linked' | 'saved' | 'updated' | 'declined' | 'failed'

export class LoginCaptureService {
  /** tabKey -> what has been typed so far. RAM only, never persisted. */
  private readonly drafts = new Map<string, LoginDraft>()
  /** Logins already offered this run (a hash, never the password), so the bubble
   * does not pop again on every retry of the same form. */
  private readonly offered = new Set<string>()
  /** One bubble at a time per profile. */
  private readonly prompting = new Set<string>()
  private preloadPath: string | null = null
  private readonly attached = new WeakSet<Session>()
  private ipcInstalled = false

  constructor(
    private readonly userDataDir: string,
    private readonly deps: LoginCaptureDeps
  ) {}

  /** Register the capture agent on a web-page session (once per session) and
   * install the ipc listener (once). */
  attach(ses: Session, resolve: (webContentsId: number) => FragmentSource | null): void {
    this.installIpc(resolve)
    if (this.attached.has(ses)) return
    this.attached.add(ses)
    ses.registerPreloadScript({
      id: 'mira-login-capture',
      type: 'frame',
      filePath: this.ensurePreload()
    })
  }

  /** Forget a tab's half-typed login (tab closed, profile locked). */
  forgetTab(tabKey: string): void {
    this.drafts.delete(tabKey)
  }

  /** Drop every draft (quit, lock-all). */
  forgetAll(): void {
    this.drafts.clear()
  }

  /** One report from a page. */
  async handleFragment(fragment: LoginFragment, source: FragmentSource): Promise<LoginOutcome> {
    // A profile with no vault never gets read: drop the report before it is even
    // stored. This is the wall between accounts — and the reason the preload is
    // not installed there in the first place.
    const vault = this.deps.vaultFor(source.profileId)
    if (!vault) return 'ignored'

    const now = this.deps.now()
    const draft = mergeLoginFragment(
      this.drafts.get(source.tabKey),
      { ...fragment, url: fragment.url || source.pageUrl },
      now.getTime()
    )
    this.drafts.set(source.tabKey, draft)

    // No submit, no offer. A password half typed and abandoned looks exactly
    // like a whole one, so intent has to come from the page.
    if (!fragment.submitted) return 'incomplete'

    const login = validateLogin(draft)
    if (!login) return 'incomplete'

    const fingerprint = loginFingerprint(login)
    if (this.offered.has(fingerprint)) return 'ignored'
    if (this.prompting.has(source.profileId)) return 'ignored'

    this.offered.add(fingerprint)
    this.prompting.add(source.profileId)
    try {
      const outcome = await this.offer(vault, login, source.profileId, now)
      // A technical failure (no bw, not logged in, network) is not an answer:
      // release the fingerprint so the next attempt can offer again instead of
      // going silent for the rest of the run.
      if (outcome === 'failed') this.offered.delete(fingerprint)
      return outcome
    } finally {
      this.prompting.delete(source.profileId)
      // Either it is in the vault or it was refused; the password should not
      // linger in memory in either case.
      this.drafts.delete(source.tabKey)
    }
  }

  /** Show the bubble and act on the answer, re-asking once when the master
   * password was wrong. */
  private async offer(
    vault: CardVault,
    login: ValidatedLogin,
    profileId: string,
    now: Date
  ): Promise<LoginOutcome> {
    let error: string | undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      let unlocked = this.deps.hasSession(vault)
      if (!unlocked) {
        // No session key yet: find out WHY before asking for anything. A vault
        // with no account logged in cannot be opened with a master password, so
        // showing that box would waste the user's time and their password.
        const state = await this.deps.vaultState(vault)
        if (state !== 'locked' && state !== 'unlocked') {
          this.deps.toast(profileId, this.messageFor(state === 'unknown' ? 'failed' : state))
          return 'failed'
        }
      }

      // Only a vault we can read can be asked "do you already have this?". When
      // it is locked the question waits until just after the unlock, below.
      let match: LoginMatch = { account: null, sameCredential: null }
      if (unlocked) {
        try {
          match = await this.deps.findMatch(vault, login)
        } catch (e) {
          const reason = e instanceof BitwardenError ? e.reason : 'failed'
          // A session key bw refuses is worse than none: fall through as if the
          // vault were locked, which is what the next attempt will ask for.
          if (reason !== 'locked') {
            this.deps.toast(profileId, this.messageFor(reason))
            return 'failed'
          }
          unlocked = false
        }
        // Nothing to do, and nothing to say: this exact login is already saved.
        if (match.account && match.account.password === login.password) return 'known'
        // The same credential, already saved on another subdomain of this site:
        // there is no second account here and no question to ask — record the
        // address on the item that holds it and stay out of the way.
        if (!match.account && match.sameCredential) {
          return await this.link(vault, match.sameCredential, login, profileId)
        }
      }

      const mode = !unlocked ? 'unlock' : match.account ? 'update' : 'save'
      const bubble = this.deps.prompt(profileId, {
        mode,
        loginLabel: loginLabel(login),
        account: vault.email ?? vault.appDataDir,
        ...(error ? { error } : {})
      })
      const answer = await bubble.answer
      if (!answer) return 'declined'

      try {
        if (answer.action === 'unlock') {
          bubble.busy('Unlocking the vault…')
          await this.deps.unlock(vault, answer.password)
        }
        // Now the vault is readable for sure: ask the question that could not be
        // asked while it was locked, so an unlock-then-save never duplicates an
        // account that was already in there.
        const found = match.account ? match : await this.deps.findMatch(vault, login)
        const target = found.account
        if (target && target.password === login.password) {
          bubble.close()
          return 'known'
        }
        if (!target && found.sameCredential) {
          bubble.close()
          return await this.link(vault, found.sameCredential, login, profileId)
        }
        if (target) {
          bubble.busy('Updating the login…')
          await this.deps.updateLogin(vault, target, login.password)
          bubble.close()
          this.deps.toast(profileId, 'Login updated in Bitwarden')
          return 'updated'
        }
        bubble.busy('Saving the login…')
        await this.deps.saveLogin(vault, login, now)
        bubble.close()
        this.deps.toast(profileId, 'Login saved to Bitwarden')
        return 'saved'
      } catch (e) {
        bubble.close()
        const reason = e instanceof BitwardenError ? e.reason : 'failed'
        if (reason === 'locked' && attempt === 0) {
          // Wrong password or a stale session: ask once more, saying so.
          error = 'Could not unlock the vault. Try again.'
          continue
        }
        this.deps.toast(profileId, this.messageFor(reason))
        return 'failed'
      }
    }
    return 'failed'
  }

  /** Record this address on the item that already holds the very same
   * credential. A failure here is not worth a toast: the password IS in the
   * vault, which is all the user cares about — only the next match is lost. */
  private async link(
    vault: CardVault,
    item: VaultLogin,
    login: ValidatedLogin,
    profileId: string
  ): Promise<LoginOutcome> {
    try {
      await this.deps.linkLogin(vault, item, login.url)
    } catch {
      return 'known'
    }
    this.deps.toast(profileId, 'Login already in Bitwarden — added this address')
    return 'linked'
  }

  private messageFor(reason: string): string {
    switch (reason) {
      case 'not-installed':
        return 'Bitwarden CLI (bw) not found'
      case 'unauthenticated':
        return 'Bitwarden vault is logged out — run bw login'
      case 'locked':
        return 'Bitwarden vault stayed locked'
      default:
        return 'Could not save the login to Bitwarden'
    }
  }

  private installIpc(resolve: (webContentsId: number) => FragmentSource | null): void {
    if (this.ipcInstalled) return
    this.ipcInstalled = true
    ipcMain.on(LOGIN_FRAGMENT_CHANNEL, (event, payload) => {
      const source = resolve(event.sender.id)
      if (!source) return
      const fragment = normalizeLoginFragment(payload)
      if (!fragment) return
      void this.handleFragment(fragment, source)
    })
  }

  private ensurePreload(): string {
    if (this.preloadPath) return this.preloadPath
    const dir = join(this.userDataDir, 'sw-shims')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const path = join(dir, 'login-capture.js')
    writeFileSync(path, LOGIN_CAPTURE_PRELOAD_SOURCE, 'utf8')
    return (this.preloadPath = path)
  }
}
