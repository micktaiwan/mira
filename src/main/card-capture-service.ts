// Assembling what the page agent reports into an offer to save, and carrying that
// offer through to the Bitwarden vault. This is the orchestration layer: the
// decisions are pure (card.ts, card-capture.ts, card-vault-store.ts), the CLI is
// bitwarden-service.ts, the bubble is card-prompt.ts.
//
// The flow, once per tab:
//   fragment (one field, one frame) -> merge into that tab's draft
//   -> draft complete? -> Luhn + expiry check (card.ts)
//   -> is this profile mapped to a vault? (unmapped = silence, the pro wall)
//   -> already offered this exact card? (fingerprint set) -> silence
//   -> bubble: "Save this card?" (or "Unlock and save" when the vault is locked)
//   -> bw create item, on stdin.
//
// Every collaborator is INJECTED so the whole flow is unit-tested without
// Electron, Bitwarden or a window (CLAUDE.md "tout testable").

import { ipcMain, type Session } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { cardFingerprint, cardLabel, validateCapture, type ValidatedCard } from './card'
import {
  draftExpiry,
  draftLooksComplete,
  mergeFragment,
  type CardDraft,
  type CardFieldKind,
  type CardFragment
} from './card-capture'
import { CARD_CAPTURE_PRELOAD_SOURCE, CARD_FRAGMENT_CHANNEL } from './card-capture-shim'
import { originHost, type CardVault } from './bitwarden'
import { BitwardenError } from './bitwarden-service'
import type { CardPromptHandle, CardPromptRequest } from './card-prompt'

/** Where a fragment came from, resolved by the caller from the ipc sender. */
export interface FragmentSource {
  /** The profile whose vault would receive the card. */
  profileId: string
  /** Stable key for the tab the fragment belongs to (drafts are per tab). */
  tabKey: string
  /** The TOP-LEVEL page url, so the prompt names the shop and not the payment
   * iframe. '' when unknown. */
  pageUrl: string
}

/** What the service needs from the outside world. All injectable. */
export interface CardCaptureDeps {
  /** The vault a profile saves to, or null when it is unmapped. */
  vaultFor: (profileId: string) => CardVault | null
  /** True when this vault already has a usable session key. */
  hasSession: (vault: CardVault) => boolean
  /** What `bw status` says about the vault. Asked BEFORE any prompt, so a vault
   * with no account logged in never gets a master-password box it cannot use. */
  vaultState: (vault: CardVault) => Promise<string>
  /** Unlock with the master password (throws BitwardenError on a bad one). */
  unlock: (vault: CardVault, password: string) => Promise<void>
  /** Write the card, returning the created item id. */
  saveCard: (vault: CardVault, card: ValidatedCard, now: Date) => Promise<string | null>
  /** Put the bubble up. The handle carries the eventual answer AND the way to
   * report progress in it, because unlocking + writing takes seconds of bw and
   * a bubble that vanished on click leaves the user with no idea what runs. */
  prompt: (profileId: string, req: CardPromptRequest) => CardPromptHandle
  /** Flash a message in the profile's window. */
  toast: (profileId: string, message: string) => void
  /** Injected clock. */
  now: () => Date
}

export class CardCaptureService {
  /** tabKey -> what has been typed so far. RAM only, never persisted. */
  private readonly drafts = new Map<string, CardDraft>()
  /** Cards already offered (fingerprint, no number), so the bubble does not pop
   * again on every keystroke, every retry, or the next tab of the same shop. */
  private readonly offered = new Set<string>()
  /** One bubble at a time per profile. */
  private readonly prompting = new Set<string>()
  private preloadPath: string | null = null
  private readonly attached = new WeakSet<Session>()
  private ipcInstalled = false

  constructor(
    private readonly userDataDir: string,
    private readonly deps: CardCaptureDeps
  ) {}

  /** Register the capture agent on a web-page session (once per session) and
   * install the ipc listener (once). */
  attach(ses: Session, resolve: (webContentsId: number) => FragmentSource | null): void {
    this.installIpc(resolve)
    if (this.attached.has(ses)) return
    this.attached.add(ses)
    ses.registerPreloadScript({
      id: 'mira-card-capture',
      type: 'frame',
      filePath: this.ensurePreload()
    })
  }

  /** Forget a tab's half-typed card (navigation away, tab closed). */
  forgetTab(tabKey: string): void {
    this.drafts.delete(tabKey)
  }

  /** One reported field. Returns what happened, which is what the tests assert
   * on: 'ignored' (nothing to do), 'incomplete' (kept for later), 'offered'
   * (bubble shown), 'saved', 'declined', 'failed'. */
  async handleFragment(
    fragment: CardFragment,
    source: FragmentSource
  ): Promise<'ignored' | 'incomplete' | 'saved' | 'declined' | 'failed'> {
    // A profile with no vault never gets read: drop the fragment on the floor
    // before it is even stored. This is the wall between accounts.
    const vault = this.deps.vaultFor(source.profileId)
    if (!vault) return 'ignored'

    const now = this.deps.now()
    const draft = mergeFragment(this.drafts.get(source.tabKey), fragment, now.getTime())
    this.drafts.set(source.tabKey, draft)
    if (!draftLooksComplete(draft)) return 'incomplete'

    const card = validateCapture(
      {
        number: draft.number,
        expiry: draftExpiry(draft),
        holder: draft.holder,
        origin: source.pageUrl
      },
      now
    )
    if (!card) return 'incomplete'

    const fingerprint = cardFingerprint(card)
    if (this.offered.has(fingerprint)) return 'ignored'
    if (this.prompting.has(source.profileId)) return 'ignored'

    this.offered.add(fingerprint)
    this.prompting.add(source.profileId)
    try {
      const outcome = await this.offer(vault, card, source.profileId, now)
      // A technical failure (no bw, not logged in, network) is not an answer:
      // release the fingerprint so the next attempt can offer again instead of
      // going silent for the rest of the run.
      if (outcome === 'failed') this.offered.delete(fingerprint)
      return outcome
    } finally {
      this.prompting.delete(source.profileId)
      // The card is either in the vault or declined; either way this tab's draft
      // has served its purpose and the number should not linger in memory.
      this.drafts.delete(source.tabKey)
    }
  }

  /** Show the bubble and act on the answer, re-asking once when the master
   * password was wrong. */
  private async offer(
    vault: CardVault,
    card: ValidatedCard,
    profileId: string,
    now: Date
  ): Promise<'saved' | 'declined' | 'failed'> {
    let error: string | undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      const unlocked = this.deps.hasSession(vault)
      if (!unlocked) {
        // No session key yet: find out WHY before asking for anything. A vault
        // with no account logged in cannot be unlocked by a master password, so
        // showing that box would just waste the user's time and their password.
        const state = await this.deps.vaultState(vault)
        if (state !== 'locked' && state !== 'unlocked') {
          this.deps.toast(profileId, this.messageFor(state === 'unknown' ? 'failed' : state))
          return 'failed'
        }
      }
      const mode = unlocked ? 'save' : 'unlock'
      const bubble = this.deps.prompt(profileId, {
        mode,
        cardLabel: cardLabel(card.brand, card.number),
        host: originHost(card.origin),
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
        bubble.busy('Saving the card…')
        await this.deps.saveCard(vault, card, now)
        bubble.close()
        this.deps.toast(profileId, `Card saved to Bitwarden`)
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

  private messageFor(reason: string): string {
    switch (reason) {
      case 'not-installed':
        return 'Bitwarden CLI (bw) not found'
      case 'unauthenticated':
        return 'Bitwarden vault is logged out — run bw login'
      case 'locked':
        return 'Bitwarden vault stayed locked'
      default:
        return 'Could not save the card to Bitwarden'
    }
  }

  private installIpc(resolve: (webContentsId: number) => FragmentSource | null): void {
    if (this.ipcInstalled) return
    this.ipcInstalled = true
    ipcMain.on(CARD_FRAGMENT_CHANNEL, (event, payload) => {
      const source = resolve(event.sender.id)
      if (!source) return
      const fragment = normalizeFragment(payload)
      if (!fragment) return
      void this.handleFragment(fragment, source)
    })
  }

  private ensurePreload(): string {
    if (this.preloadPath) return this.preloadPath
    const dir = join(this.userDataDir, 'sw-shims')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const path = join(dir, 'card-capture.js')
    writeFileSync(path, CARD_CAPTURE_PRELOAD_SOURCE, 'utf8')
    return (this.preloadPath = path)
  }
}

const FIELD_KINDS: readonly CardFieldKind[] = [
  'number',
  'expiry',
  'exp-month',
  'exp-year',
  'holder',
  'cvc'
]

/** Coerce the UNTRUSTED fragment payload (it crosses from a web page) into a
 * CardFragment, or null when it is malformed. Values are capped so a hostile page
 * cannot push megabytes through the channel. Pure. */
export function normalizeFragment(payload: unknown): CardFragment | null {
  const p = (payload ?? {}) as { kind?: unknown; value?: unknown; frameOrigin?: unknown }
  if (typeof p.kind !== 'string' || !FIELD_KINDS.includes(p.kind as CardFieldKind)) return null
  if (typeof p.value !== 'string') return null
  const value = p.value.slice(0, 120).trim()
  if (!value) return null
  return {
    kind: p.kind as CardFieldKind,
    value,
    frameOrigin: typeof p.frameOrigin === 'string' ? p.frameOrigin.slice(0, 300) : ''
  }
}
