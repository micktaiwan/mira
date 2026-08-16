// Cards domain: saving a payment card into a Bitwarden vault, and the profile ->
// vault mapping that decides WHICH account (if any) a profile may write to.
//
// Naming note: this is NOT the profile "vault" (that is disk encryption of a
// whole profile, vault.ts / commands/vault.ts). Here a vault means one Bitwarden
// account, addressed by its BITWARDENCLI_APPDATA_DIR.
//
// `save-card` exists as a command, not only as an internal call from the capture
// pipeline, so the whole chain down to `bw create item` can be driven from the
// socket without typing into a real checkout (CLAUDE.md "tout pilotable").

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'

/** One profile's card vault as the UI/socket sees it. */
export interface CardVaultInfo {
  profileId: string
  appDataDir: string
  email?: string
  /** Whether Mira currently holds a usable session key for it. */
  unlocked: boolean
  /** What `bw status` said the last time it was asked: 'unauthenticated' means
   * no account is logged in that appdata dir, so nothing can be saved until
   * `bw login` is run there. Absent when it was not checked. */
  state?: string
}

/** Cards capability slice. */
export interface CardsContext {
  /** Every profile -> vault mapping. */
  listCardVaults: () => CardVaultInfo[]
  /** Map a profile to a Bitwarden account (an appdata dir). */
  setCardVault: (profileId: string, appDataDir: string) => Promise<CardVaultInfo>
  /** Unmap a profile: it stops capturing and offering cards entirely. */
  removeCardVault: (profileId: string) => { profileId: string }
  /** What `bw status` reports for that profile's vault. */
  cardVaultStatus: (profileId: string) => Promise<{ state: string; email?: string }>
  /** Unlock with the master password; the session stays in memory only. */
  unlockCardVault: (profileId: string, password: string) => Promise<{ profileId: string }>
  /** Every card already stored in a profile's vault (last four digits only). */
  listCards: (profileId?: string) => Promise<{ profileId: string; cards: unknown[] }>
  /** Remove one card from a profile's vault (soft delete). */
  deleteCard: (id: string, profileId?: string) => Promise<{ profileId: string; name: string }>
  /** Write a card into a profile's vault, returning the created item id. */
  saveCard: (params: {
    profileId?: string
    number: string
    expiry: string
    holder?: string
    origin?: string
  }) => Promise<{ id: string | null; label: string }>
}

/** Read a required non-empty string param. */
function str(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`"${name}" must be a non-empty string`)
  }
  return value.trim()
}

export const cardsCommands: CommandMap<CommandContext> = {
  // Which profiles can save cards, and where. A profile absent from this list
  // never captures a card at all.
  'list-card-vaults': (ctx) => {
    try {
      return { ok: true, vaults: ctx.listCardVaults() }
    } catch (error) {
      return fail(error)
    }
  },

  // Map a profile to a Bitwarden account: { profileId, appDataDir }. The dir is
  // a BITWARDENCLI_APPDATA_DIR, which is what makes one account one vault.
  'set-card-vault': async (ctx, params) => {
    const p = (params ?? {}) as { profileId?: unknown; appDataDir?: unknown }
    try {
      return {
        ok: true,
        vault: await ctx.setCardVault(
          str(p.profileId, 'profileId'),
          str(p.appDataDir, 'appDataDir')
        )
      }
    } catch (error) {
      return fail(error)
    }
  },

  // Stop a profile from saving cards: { profileId }.
  'remove-card-vault': (ctx, params) => {
    const p = (params ?? {}) as { profileId?: unknown }
    try {
      return { ok: true, ...ctx.removeCardVault(str(p.profileId, 'profileId')) }
    } catch (error) {
      return fail(error)
    }
  },

  // What bw says about a profile's vault: { profileId } -> unauthenticated /
  // locked / unlocked.
  'card-vault-status': async (ctx, params) => {
    const p = (params ?? {}) as { profileId?: unknown }
    try {
      return { ok: true, ...(await ctx.cardVaultStatus(str(p.profileId, 'profileId'))) }
    } catch (error) {
      return fail(error)
    }
  },

  // Unlock a profile's vault with the master password: { profileId, password }.
  // The session key lives in memory until Mira quits.
  'unlock-card-vault': async (ctx, params) => {
    const p = (params ?? {}) as { profileId?: unknown; password?: unknown }
    try {
      return {
        ok: true,
        ...(await ctx.unlockCardVault(str(p.profileId, 'profileId'), str(p.password, 'password')))
      }
    } catch (error) {
      return fail(error)
    }
  },

  // Read the cards already in a profile's vault: { profileId? }. Only the last
  // four digits come back — the full number never leaves Bitwarden. A locked
  // vault pops the native master-password bubble rather than failing.
  'list-cards': async (ctx, params) => {
    const p = (params ?? {}) as { profileId?: unknown }
    try {
      const profileId =
        typeof p.profileId === 'string' && p.profileId.trim() ? p.profileId.trim() : undefined
      return { ok: true, ...(await ctx.listCards(profileId)) }
    } catch (error) {
      return fail(error)
    }
  },

  // Remove a card from a vault: { id, profileId? }. Soft delete — the item goes
  // to Bitwarden's trash. The id must belong to a CARD of that vault, so a wrong
  // id cannot take a login down with it.
  'delete-card': async (ctx, params) => {
    const p = (params ?? {}) as { id?: unknown; profileId?: unknown }
    try {
      const profileId =
        typeof p.profileId === 'string' && p.profileId.trim() ? p.profileId.trim() : undefined
      return { ok: true, ...(await ctx.deleteCard(str(p.id, 'id'), profileId)) }
    } catch (error) {
      return fail(error)
    }
  },

  // Write a card straight into a vault: { number, expiry, holder?, origin?,
  // profileId? }. Rejects anything that is not a plausible, unexpired card, the
  // same gate the capture pipeline uses.
  'save-card': async (ctx, params) => {
    const p = (params ?? {}) as {
      profileId?: unknown
      number?: unknown
      expiry?: unknown
      holder?: unknown
      origin?: unknown
    }
    try {
      const result = await ctx.saveCard({
        ...(typeof p.profileId === 'string' && p.profileId.trim()
          ? { profileId: p.profileId.trim() }
          : {}),
        number: str(p.number, 'number'),
        expiry: str(p.expiry, 'expiry'),
        ...(typeof p.holder === 'string' ? { holder: p.holder } : {}),
        ...(typeof p.origin === 'string' ? { origin: p.origin } : {})
      })
      return { ok: true, ...result }
    } catch (error) {
      return fail(error)
    }
  }
}
