// The login feature, assembled: the capture pipeline, the save/update bubble, and
// the socket commands. ProfileManager owns ONE of these and forwards the
// command-context calls to it, so the feature lives here rather than growing
// profiles.ts (CLAUDE.md, découpage anti-collision).
//
// What each collaborator does:
//   login-capture.ts        classify, merge the two halves, decide (pure)
//   login-capture-shim.ts   the page agent that reads the form
//   login-capture-service   reports -> a login -> the offer (injected, tested)
//   login-prompt.ts         the native bubble
//   bitwarden-login.ts      the vault item, and "is this already saved?" (pure)
//   bitwarden-service.ts    the `bw` process, session keys in RAM
//   login-fill.ts           which stored account fits this page (pure)
//   login-fill-shim.ts      the page agent that WRITES the form
//   login-fill-service.ts   the fill flow, and what it remembers
//   login-pick-prompt.ts    the "which account?" bubble
//
// The fill half rides on the same three things as the capture half — the same
// profile → account map, the same unlocked session, the same master-password
// bubble — so a vault opened at a checkout is the vault that fills the next
// login, and a profile mapped to nothing gets neither agent.
//
// It does NOT own the profile → Bitwarden account map, and that is deliberate: it
// borrows card-service's (VaultAccess), so a profile is mapped once and the wall
// between the perso and the pro accounts is one wall. It borrows the same
// BitwardenService too, so the master password typed at a checkout also covers
// the next login saved.

import { BrowserWindow, type Session, type WebContents } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { CardVault } from './bitwarden'
import {
  findLoginMatch,
  redactLogins,
  type LoginMatch,
  type StoredLogin,
  type VaultLogin
} from './bitwarden-login'
import { BitwardenError } from './bitwarden-service'
import type { VaultAccess } from './card-service'
import type { FragmentSource } from './card-capture-service'
import { CARD_PROMPT_PRELOAD_SOURCE, showCardPrompt, type CardPromptHandle } from './card-prompt'
import { LoginCaptureService } from './login-capture-service'
import { loginLabel, validateLogin, type LoginDraft, type ValidatedLogin } from './login-capture'
import { showLoginPrompt, type LoginPromptRequest } from './login-prompt'
import { LoginFillService, type FillOutcome } from './login-fill-service'
import { showLoginPick } from './login-pick-prompt'
import type { FillCandidate } from './login-fill'

export interface LoginServiceDeps {
  userDataDir: string
  /** The Bitwarden session keys and the profile → account map, both shared with
   * the card feature. */
  access: VaultAccess
  /** The window a profile's bubble belongs to, or null when it is closed. */
  windowFor: (profileId: string) => BrowserWindow | null
  /** Flash a message in a profile's window. */
  toast: (profileId: string, message: string) => void
}

export class LoginService {
  private readonly capture: LoginCaptureService
  private readonly fillService: LoginFillService
  private promptPreloadPath: string | null = null

  constructor(private readonly deps: LoginServiceDeps) {
    const bw = deps.access.bitwarden
    this.fillService = new LoginFillService(deps.userDataDir, {
      vaultFor: deps.access.vaultFor,
      // The SAME read as listLogins: it opens a locked vault through the native
      // bubble, so a fill asked for from the socket never dead-ends on "locked".
      readLogins: (profileId, vault) => this.readLogins(profileId, vault),
      // Every frame, because a login form is very often an iframe (SSO widgets):
      // the frames with no form simply answer that they filled nothing.
      framesOf: (contents) => {
        const main = contents.mainFrame
        return main ? main.framesInSubtree : []
      },
      urlOf: (contents) => contents.getURL(),
      pick: (params) => this.askWhichLogin(params)
    })
    this.capture = new LoginCaptureService(deps.userDataDir, {
      vaultFor: deps.access.vaultFor,
      hasSession: (vault) => bw.hasSession(vault),
      vaultState: async (vault) => (await bw.status(vault)).state,
      unlock: (vault, password) => bw.unlock(vault, password),
      findMatch: (vault, login) => this.findMatch(vault, login),
      saveLogin: (vault, login, now) => bw.saveLogin(vault, login, now),
      updateLogin: (vault, existing, password) => bw.updateLogin(vault, existing, password),
      linkLogin: (vault, existing, uri) => bw.linkLoginUri(vault, existing, uri),
      prompt: (profileId, req) => this.showPrompt(profileId, req),
      toast: deps.toast,
      now: () => new Date()
    })
  }

  /** Install the page-side capture agent on a profile's web session. No-op for a
   * profile with no vault: nothing is injected, so no password is ever read
   * there — not even to be dropped. */
  attach(profileId: string, ses: Session, resolve: (id: number) => FragmentSource | null): void {
    if (!this.deps.access.vaultFor(profileId)) return
    this.capture.attach(ses, resolve)
    // Same gate, same reason: the fill agent is the only code that can put a
    // vault password into a page, so an unmapped profile never receives it.
    this.fillService.attach(ses)
  }

  /** A tab went away: drop its half-typed login. */
  forgetTab(tabKey: string): void {
    this.capture.forgetTab(tabKey)
  }

  // ── command context ──────────────────────────────────────────────────────

  /** The logins already in a profile's vault, NEVER their passwords. When the
   * vault is locked this does not fail: it asks for the master password in the
   * same native bubble the save flow uses. `domain` narrows to the items that
   * carry a uri on that host. */
  async listLogins(params: { profileId: string; domain?: string }): Promise<{
    profileId: string
    logins: StoredLogin[]
  }> {
    const { profileId } = params
    const vault = this.requireVault(profileId)
    const items = await this.readLogins(profileId, vault)
    const host = (params.domain ?? '').trim().toLowerCase()
    const filtered = host
      ? items.filter((item) => item.hosts.some((h) => h === host || h.endsWith(`.${host}`)))
      : items
    return { profileId, logins: redactLogins(filtered) }
  }

  /** Write a login straight into a profile's vault (the socket path). Same gate
   * as the capture pipeline, and the same "already there?" rule: an account the
   * vault already holds is UPDATED, never duplicated, and the same credential
   * met on another subdomain of a site the vault covers only gets that address
   * added (`linked`). */
  async saveLogin(params: {
    profileId: string
    url: string
    username?: string
    password: string
  }): Promise<{ id: string | null; label: string; updated: boolean; linked: boolean }> {
    const { profileId } = params
    const vault = this.requireVault(profileId)
    const draft: LoginDraft = {
      username: (params.username ?? '').trim(),
      password: params.password,
      kind: 'current',
      // The socket caller says what it means; there is no form to infer from.
      usernameExpected: false,
      url: params.url,
      updatedAt: Date.now()
    }
    const login = validateLogin(draft)
    if (!login) throw new Error('not a valid login (needs an http(s) url and a real password)')
    // Say WHICH wall was hit: a locked vault needs unlock-card-vault, a vault
    // with no account logged in needs `bw login` in that appdata dir.
    if (!this.deps.access.bitwarden.hasSession(vault)) {
      const { state } = await this.deps.access.bitwarden.status(vault)
      if (state === 'unauthenticated') {
        throw new Error(`Bitwarden vault is not logged in (bw login in ${vault.appDataDir})`)
      }
      throw new Error('vault is locked — run unlock-card-vault first')
    }
    const { account, sameCredential } = await this.findMatch(vault, login)
    if (account) {
      if (account.password === login.password) {
        return { id: account.id, label: loginLabel(login), updated: false, linked: false }
      }
      await this.deps.access.bitwarden.updateLogin(vault, account, login.password)
      return { id: account.id, label: loginLabel(login), updated: true, linked: false }
    }
    if (sameCredential) {
      await this.deps.access.bitwarden.linkLoginUri(vault, sameCredential, login.url)
      return { id: sameCredential.id, label: loginLabel(login), updated: false, linked: true }
    }
    const id = await this.deps.access.bitwarden.saveLogin(vault, login, new Date())
    return { id, label: loginLabel(login), updated: false, linked: false }
  }

  /** The accounts that could log in on a tab's page, no passwords. The "show me
   * the list" half of filling. */
  async loginCandidates(params: { profileId: string; contents: WebContents }): Promise<{
    profileId: string
    url: string
    host: string
    candidates: FillCandidate[]
  }> {
    return this.fillService.candidates(params)
  }

  /** Put a credential the vault holds into the tab's login form. Fills only when
   * the account is not a guess; otherwise it answers with the list and types
   * nothing. Never returns the password, never submits the form. */
  async fillLogin(params: {
    profileId: string
    contents: WebContents
    id?: string
    username?: string
    ask?: boolean
  }): Promise<FillOutcome> {
    return this.fillService.fill(params)
  }

  /** Forget which account was chosen on which site for a profile (profile
   * deleted, its data cleared). */
  forgetFills(profileId: string): void {
    this.fillService.forgetProfile(profileId)
  }

  /** Remove one login from a profile's vault (soft delete — it lands in
   * Bitwarden's trash, recoverable).
   *
   * The id is CHECKED against the vault's LOGINS first: a mistyped or stale id
   * would otherwise delete whatever item happens to carry it, a card for
   * instance. Refusing is cheap; deleting the wrong secret is not. */
  async deleteLogin(id: string, profileId: string): Promise<{ profileId: string; name: string }> {
    const pid = profileId
    const vault = this.requireVault(pid)
    const items = await this.readLogins(pid, vault)
    const login = items.find((item) => item.id === id)
    if (!login) throw new Error(`no login with id ${id} in this vault`)
    await this.deps.access.bitwarden.deleteItem(vault, id)
    return { profileId: pid, name: login.name }
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** What the vault already holds for this login: the account itself, or the
   * same credential filed under another subdomain. One `bw list items` answers
   * both questions. Only ever called on an unlocked vault (the capture pipeline
   * checks first). */
  private async findMatch(vault: CardVault, login: ValidatedLogin): Promise<LoginMatch> {
    const items = await this.deps.access.bitwarden.listLogins(vault)
    return findLoginMatch(items, login)
  }

  /** Read the vault's logins, popping the master-password bubble when it is
   * locked so a socket call never dead-ends on "locked". */
  private async readLogins(profileId: string, vault: CardVault): Promise<VaultLogin[]> {
    if (!this.deps.access.bitwarden.hasSession(vault)) {
      await this.unlockViaPrompt(profileId, vault)
    }
    return this.deps.access.bitwarden.listLogins(vault)
  }

  /** Ask for the master password in the CARD bubble's 'unlock-vault' mode (the
   * question is about the vault, not about a login, so it is the same box) and
   * unlock. Throws when the user dismisses it or the password is wrong. */
  private async unlockViaPrompt(profileId: string, vault: CardVault): Promise<void> {
    const parent = this.deps.windowFor(profileId)
    if (!parent || parent.isDestroyed()) {
      throw new BitwardenError('locked', 'vault is locked and no window can ask for the password')
    }
    const bubble = showCardPrompt(
      {
        mode: 'unlock-vault',
        cardLabel: '',
        host: '',
        account: vault.email ?? vault.appDataDir
      },
      // Raised: this prompt answers a command run from outside Mira, so the
      // window it belongs to is very likely behind something else.
      { parent, preloadPath: this.ensurePromptPreload(), raise: true }
    )
    const answer = await bubble.answer
    if (!answer || answer.action !== 'unlock') {
      throw new BitwardenError('locked', 'vault is locked — the unlock prompt was dismissed')
    }
    bubble.busy('Unlocking the vault…')
    try {
      await this.deps.access.bitwarden.unlock(vault, answer.password)
    } finally {
      bubble.close()
    }
  }

  /** Ask which of several accounts to fill with, in the native picker. Resolves
   * with the chosen vault item id, or null when the bubble is dismissed — or
   * when the profile has no window, in which case nobody can be asked and the
   * fill answers with the list instead.
   *
   * The bubble is closed here whatever the answer: unlike the save bubble, what
   * follows a pick is instant (the pair goes to the page agent), so there is no
   * progress to show. */
  private async askWhichLogin(params: {
    profileId: string
    host: string
    candidates: FillCandidate[]
  }): Promise<string | null> {
    const parent = this.deps.windowFor(params.profileId)
    if (!parent || parent.isDestroyed()) return null
    const vault = this.deps.access.vaultFor(params.profileId)
    const bubble = showLoginPick(
      {
        host: params.host,
        account: vault?.email ?? vault?.appDataDir ?? '',
        options: params.candidates.map((candidate) => ({
          id: candidate.id,
          username: candidate.username,
          name: candidate.name,
          exact: candidate.exact,
          // The address that makes a non-exact entry tellable from the others:
          // its first host, which is where it was actually saved.
          host: candidate.hosts[0] ?? ''
        }))
      },
      { parent, preloadPath: this.ensurePromptPreload() }
    )
    try {
      const answer = await bubble.answer
      return answer && answer.action === 'pick' ? answer.id : null
    } finally {
      bubble.close()
    }
  }

  private showPrompt(profileId: string, req: LoginPromptRequest): CardPromptHandle {
    const parent = this.deps.windowFor(profileId)
    // No window means nobody can answer; treat it as "not now" rather than
    // saving silently.
    if (!parent || parent.isDestroyed()) {
      return { answer: Promise.resolve(null), busy: () => {}, close: () => {} }
    }
    return showLoginPrompt(req, { parent, preloadPath: this.ensurePromptPreload() })
  }

  private requireVault(profileId: string): CardVault {
    const vault = this.deps.access.vaultFor(profileId)
    if (!vault) throw new Error(`no card vault for profile: ${profileId}`)
    return vault
  }

  private ensurePromptPreload(): string {
    if (this.promptPreloadPath) return this.promptPreloadPath
    const dir = join(this.deps.userDataDir, 'sw-shims')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const path = join(dir, 'login-prompt-preload.js')
    writeFileSync(path, CARD_PROMPT_PRELOAD_SOURCE, 'utf8')
    return (this.promptPreloadPath = path)
  }
}
