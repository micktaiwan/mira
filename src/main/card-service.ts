// The card feature, assembled: the profile -> Bitwarden account map on disk, the
// capture pipeline, the save bubble, and the CLI. ProfileManager owns ONE of
// these and forwards the command-context calls to it, so the feature lives here
// rather than growing profiles.ts (CLAUDE.md, découpage anti-collision).
//
// What each collaborator does:
//   card-vault-store.ts   which profile writes to which Bitwarden account (pure)
//   card-capture-service  fragments -> a card -> the offer (pure-ish, injected)
//   card-prompt.ts        the native bubble
//   bitwarden-service.ts  the `bw` process, session keys in RAM
//
// The mapping is persisted to userData/card-vaults.json. A profile that is not
// in it never captures anything: that absence IS the wall between the perso and
// the pro accounts.

import { BrowserWindow, type Session } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { CardVaultInfo } from './commands'
import { BitwardenError, BitwardenService } from './bitwarden-service'
import type { CardVault, StoredCard } from './bitwarden'
import { CardCaptureService, type FragmentSource } from './card-capture-service'
import {
  CARD_PROMPT_PRELOAD_SOURCE,
  showCardPrompt,
  type CardPromptHandle,
  type CardPromptRequest
} from './card-prompt'
import {
  parseVaultMap,
  rememberEmail,
  removeVault,
  setVault,
  vaultFor,
  type CardVaultMap
} from './card-vault-store'
import { validateCapture, cardLabel } from './card'

/** What card-service lends to the login feature. Deliberately narrow: the bw
 * process wrapper (which holds the unlocked session keys) and the profile →
 * account lookup. Nothing about cards crosses. */
export interface VaultAccess {
  bitwarden: BitwardenService
  vaultFor: (profileId: string) => CardVault | null
}

export interface CardServiceDeps {
  userDataDir: string
  /** The window a profile's bubble belongs to, or null when it is closed. */
  windowFor: (profileId: string) => BrowserWindow | null
  /** Flash a message in a profile's window. */
  toast: (profileId: string, message: string) => void
}

export class CardService {
  private readonly bitwarden = new BitwardenService()
  private readonly capture: CardCaptureService
  private map: CardVaultMap
  private promptPreloadPath: string | null = null

  constructor(private readonly deps: CardServiceDeps) {
    this.map = this.load()
    this.capture = new CardCaptureService(deps.userDataDir, {
      vaultFor: (profileId) => vaultFor(this.map, profileId),
      hasSession: (vault) => this.bitwarden.hasSession(vault),
      vaultState: async (vault) => (await this.bitwarden.status(vault)).state,
      unlock: (vault, password) => this.bitwarden.unlock(vault, password),
      saveCard: (vault, card, now) => this.bitwarden.saveCard(vault, card, now),
      prompt: (profileId, req) => this.showPrompt(profileId, req),
      toast: deps.toast,
      now: () => new Date()
    })
  }

  /** Install the page-side capture agent on a profile's web session. No-op for a
   * profile with no card vault: nothing is injected, nothing is watched. */
  attach(profileId: string, ses: Session, resolve: (id: number) => FragmentSource | null): void {
    if (!vaultFor(this.map, profileId)) return
    this.capture.attach(ses, resolve)
  }

  /** A tab went away / navigated: drop its half-typed card. */
  forgetTab(tabKey: string): void {
    this.capture.forgetTab(tabKey)
  }

  /** The Bitwarden plumbing a sibling feature reuses (login-service.ts): the SAME
   * session keys, so one master password typed at a checkout also covers the next
   * login saved, and the SAME profile → account map, so the wall between the
   * perso and the pro accounts is ONE wall rather than two that can disagree. */
  vaultAccess(): VaultAccess {
    return {
      bitwarden: this.bitwarden,
      vaultFor: (profileId) => vaultFor(this.map, profileId)
    }
  }

  // ── command context ──────────────────────────────────────────────────────

  listCardVaults(): CardVaultInfo[] {
    return Object.entries(this.map).map(([profileId, vault]) => ({
      profileId,
      appDataDir: vault.appDataDir,
      ...(vault.email ? { email: vault.email } : {}),
      unlocked: this.bitwarden.hasSession(vault)
    }))
  }

  /** Map a profile to a Bitwarden account. The account's email is read from `bw
   * status` right away, so the mapping is verified at the moment it is made
   * rather than at the first checkout. */
  async setCardVault(profileId: string, appDataDir: string): Promise<CardVaultInfo> {
    this.map = setVault(this.map, profileId, { appDataDir }, homedir())
    const vault = vaultFor(this.map, profileId) as CardVault
    const status = await this.bitwarden.status(vault)
    if (status.email) this.map = rememberEmail(this.map, profileId, status.email)
    this.save()
    return {
      profileId,
      appDataDir: vault.appDataDir,
      ...(status.email ? { email: status.email } : {}),
      unlocked: this.bitwarden.hasSession(vault),
      state: status.state
    }
  }

  removeCardVault(profileId: string): { profileId: string } {
    const vault = this.requireVault(profileId)
    this.bitwarden.forget(vault)
    this.map = removeVault(this.map, profileId)
    this.save()
    return { profileId }
  }

  async cardVaultStatus(profileId: string): Promise<{ state: string; email?: string }> {
    const vault = this.requireVault(profileId)
    const status = await this.bitwarden.status(vault)
    // A vault Mira holds a session key for reads as unlocked even though a bare
    // `bw status` (which never sees that key) would say locked.
    const state = this.bitwarden.hasSession(vault) ? 'unlocked' : status.state
    if (status.email) {
      this.map = rememberEmail(this.map, profileId, status.email)
      this.save()
    }
    return { state, ...(status.email ? { email: status.email } : {}) }
  }

  async unlockCardVault(profileId: string, password: string): Promise<{ profileId: string }> {
    await this.bitwarden.unlock(this.requireVault(profileId), password)
    return { profileId }
  }

  /** Save a card straight into a profile's vault (the socket path). Same gate as
   * the capture pipeline: Luhn, a readable expiry, and not already expired. */
  async saveCard(params: {
    profileId?: string
    number: string
    expiry: string
    holder?: string
    origin?: string
  }): Promise<{ id: string | null; label: string }> {
    const profileId = params.profileId ?? this.firstMappedProfile()
    const vault = this.requireVault(profileId)
    const card = validateCapture(
      {
        number: params.number,
        expiry: params.expiry,
        holder: params.holder ?? '',
        origin: params.origin ?? ''
      },
      new Date()
    )
    if (!card) throw new Error('not a valid, unexpired card')
    // Say WHICH wall was hit: a locked vault needs unlock-card-vault, a vault
    // with no account logged in needs `bw login` in that appdata dir and no
    // master password will help.
    if (!this.bitwarden.hasSession(vault)) {
      const { state } = await this.bitwarden.status(vault)
      if (state === 'unauthenticated') {
        throw new Error(`Bitwarden vault is not logged in (bw login in ${vault.appDataDir})`)
      }
      throw new Error('vault is locked — run unlock-card-vault first')
    }
    const id = await this.bitwarden.saveCard(vault, card, new Date())
    return { id, label: cardLabel(card.brand, card.number) }
  }

  /** Every card already in a profile's vault. When the vault is locked this does
   * NOT fail: it asks for the master password in the same native bubble the save
   * flow uses, so reading the cards back never means typing a secret into a
   * shell. Refusing the bubble surfaces as a plain "locked" error. */
  async listCards(profileId?: string): Promise<{ profileId: string; cards: StoredCard[] }> {
    const id = profileId ?? this.firstMappedProfile()
    const vault = this.requireVault(id)
    if (!this.bitwarden.hasSession(vault)) await this.unlockViaPrompt(id, vault)
    return { profileId: id, cards: await this.bitwarden.listCards(vault) }
  }

  /** Delete one card from a profile's vault (soft delete — it lands in
   * Bitwarden's trash, recoverable).
   *
   * The id is CHECKED against the vault's cards first: a mistyped or stale id
   * would otherwise delete whatever item happens to carry it, a login for
   * instance. Refusing is cheap; deleting the wrong secret is not. */
  async deleteCard(id: string, profileId?: string): Promise<{ profileId: string; name: string }> {
    const pid = profileId ?? this.firstMappedProfile()
    const vault = this.requireVault(pid)
    if (!this.bitwarden.hasSession(vault)) await this.unlockViaPrompt(pid, vault)
    const card = (await this.bitwarden.listCards(vault)).find((c) => c.id === id)
    if (!card) throw new Error(`no card with id ${id} in this vault`)
    await this.bitwarden.deleteItem(vault, id)
    return { profileId: pid, name: card.name }
  }

  /** Ask for the master password in the bubble and unlock. Throws when the user
   * dismisses it or the password is wrong. */
  private async unlockViaPrompt(profileId: string, vault: CardVault): Promise<void> {
    const bubble = this.showPrompt(
      profileId,
      {
        mode: 'unlock-vault',
        cardLabel: '',
        host: '',
        account: vault.email ?? vault.appDataDir
      },
      // Raised: this prompt answers a command run from outside Mira, so the
      // window it belongs to is very likely behind something else.
      true
    )
    const answer = await bubble.answer
    if (!answer || answer.action !== 'unlock') {
      throw new BitwardenError('locked', 'vault is locked — the unlock prompt was dismissed')
    }
    bubble.busy('Unlocking the vault…')
    try {
      await this.bitwarden.unlock(vault, answer.password)
    } finally {
      bubble.close()
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private requireVault(profileId: string): CardVault {
    const vault = vaultFor(this.map, profileId)
    if (!vault) throw new Error(`no card vault for profile: ${profileId}`)
    return vault
  }

  private firstMappedProfile(): string {
    const first = Object.keys(this.map)[0]
    if (!first) throw new Error('no profile is mapped to a card vault')
    return first
  }

  private showPrompt(profileId: string, req: CardPromptRequest, raise = false): CardPromptHandle {
    const parent = this.deps.windowFor(profileId)
    // No window means nobody can answer; treat it as "not now" rather than
    // saving silently.
    if (!parent || parent.isDestroyed()) {
      return { answer: Promise.resolve(null), busy: () => {}, close: () => {} }
    }
    return showCardPrompt(req, { parent, preloadPath: this.ensurePromptPreload(), raise })
  }

  private ensurePromptPreload(): string {
    if (this.promptPreloadPath) return this.promptPreloadPath
    const dir = join(this.deps.userDataDir, 'sw-shims')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const path = join(dir, 'card-prompt-preload.js')
    writeFileSync(path, CARD_PROMPT_PRELOAD_SOURCE, 'utf8')
    return (this.promptPreloadPath = path)
  }

  private get file(): string {
    return join(this.deps.userDataDir, 'card-vaults.json')
  }

  private load(): CardVaultMap {
    try {
      return parseVaultMap(JSON.parse(readFileSync(this.file, 'utf8')), homedir())
    } catch {
      // Absent or corrupted: no profile saves cards until it is set again.
      return {}
    }
  }

  private save(): void {
    try {
      writeFileSync(this.file, `${JSON.stringify(this.map, null, 2)}\n`, 'utf8')
    } catch {
      // Persistence is best-effort; the in-memory map still works this run.
    }
  }
}
