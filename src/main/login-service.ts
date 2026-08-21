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
//
// It does NOT own the profile → Bitwarden account map, and that is deliberate: it
// borrows card-service's (VaultAccess), so a profile is mapped once and the wall
// between the perso and the pro accounts is one wall. It borrows the same
// BitwardenService too, so the master password typed at a checkout also covers
// the next login saved.

import { BrowserWindow, type Session } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { CardVault } from './bitwarden'
import { matchLogin, redactLogins, type StoredLogin, type VaultLogin } from './bitwarden-login'
import { BitwardenError } from './bitwarden-service'
import type { VaultAccess } from './card-service'
import type { FragmentSource } from './card-capture-service'
import { CARD_PROMPT_PRELOAD_SOURCE, showCardPrompt, type CardPromptHandle } from './card-prompt'
import { LoginCaptureService } from './login-capture-service'
import { loginLabel, validateLogin, type LoginDraft, type ValidatedLogin } from './login-capture'
import { showLoginPrompt, type LoginPromptRequest } from './login-prompt'

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
  private promptPreloadPath: string | null = null

  constructor(private readonly deps: LoginServiceDeps) {
    const bw = deps.access.bitwarden
    this.capture = new LoginCaptureService(deps.userDataDir, {
      vaultFor: deps.access.vaultFor,
      hasSession: (vault) => bw.hasSession(vault),
      vaultState: async (vault) => (await bw.status(vault)).state,
      unlock: (vault, password) => bw.unlock(vault, password),
      findExisting: (vault, login) => this.findExisting(vault, login),
      saveLogin: (vault, login, now) => bw.saveLogin(vault, login, now),
      updateLogin: (vault, existing, password) => bw.updateLogin(vault, existing, password),
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
   * vault already holds is UPDATED, never duplicated. */
  async saveLogin(params: {
    profileId: string
    url: string
    username?: string
    password: string
  }): Promise<{ id: string | null; label: string; updated: boolean }> {
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
    const existing = await this.findExisting(vault, login)
    if (existing) {
      if (existing.password === login.password) {
        return { id: existing.id, label: loginLabel(login), updated: false }
      }
      await this.deps.access.bitwarden.updateLogin(vault, existing, login.password)
      return { id: existing.id, label: loginLabel(login), updated: true }
    }
    const id = await this.deps.access.bitwarden.saveLogin(vault, login, new Date())
    return { id, label: loginLabel(login), updated: false }
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

  /** The vault item that already holds this account, or null. Only ever called
   * on an unlocked vault (the capture pipeline checks first). */
  private async findExisting(vault: CardVault, login: ValidatedLogin): Promise<VaultLogin | null> {
    const items = await this.deps.access.bitwarden.listLogins(vault)
    return matchLogin(items, login)
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
