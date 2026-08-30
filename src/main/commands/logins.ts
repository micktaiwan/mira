// Logins domain: saving the username/password typed into a page into a Bitwarden
// vault, and reading back what is already there.
//
// It rides on the SAME profile → Bitwarden account mapping as the cards domain
// (`set-card-vault` and friends, commands/cards.ts): a profile with no mapping
// never captures a password at all — the page agent is not even installed there.
// One mapping, one wall, both features.
//
// `save-login` exists as a command, not only as an internal call from the capture
// pipeline, so the whole chain down to `bw create item` can be driven from the
// socket without typing into a real login form (CLAUDE.md "tout pilotable").
//
// No command ever returns a password. `list-logins` answers with names, usernames
// and hosts; the secret stays in the vault.

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'

/** One stored login as the socket/UI sees it — no password, ever. */
export interface LoginInfo {
  id: string
  name: string
  username: string
  /** The hosts of the item's uris. */
  hosts: string[]
}

/** Logins capability slice. */
export interface LoginsContext {
  /** The logins in a profile's vault (no passwords). A locked vault pops the
   * native master-password bubble rather than failing. */
  listLogins: (params: { profileId?: string; domain?: string }) => Promise<{
    profileId: string
    logins: LoginInfo[]
  }>
  /** Write a login into a profile's vault. An account the vault already holds is
   * updated in place, never duplicated; the same credential already saved on
   * another subdomain of the site only gets this address added (`linked`). */
  saveLogin: (params: {
    profileId?: string
    url: string
    username?: string
    password: string
  }) => Promise<{ id: string | null; label: string; updated: boolean; linked: boolean }>
  /** Remove one login from a profile's vault (soft delete). */
  deleteLogin: (id: string, profileId?: string) => Promise<{ profileId: string; name: string }>
}

/** Read a required non-empty string param. */
function str(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`"${name}" must be a non-empty string`)
  }
  return value.trim()
}

/** A password param, checked but NOT trimmed: leading or trailing whitespace can
 * be part of a real password, and silently eating it would save a secret that
 * does not open anything. */
function password(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('"password" must be a non-empty string')
  }
  return value
}

/** An optional string param, or undefined when it is absent/empty. */
function opt(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

export const loginsCommands: CommandMap<CommandContext> = {
  // What is already in a profile's vault: { profileId?, domain? }. Passwords are
  // never part of the answer.
  'list-logins': async (ctx, params) => {
    const p = (params ?? {}) as { profileId?: unknown; domain?: unknown }
    try {
      const profileId = opt(p.profileId)
      const domain = opt(p.domain)
      return {
        ok: true,
        ...(await ctx.listLogins({
          ...(profileId ? { profileId } : {}),
          ...(domain ? { domain } : {})
        }))
      }
    } catch (error) {
      return fail(error)
    }
  },

  // Write a login straight into the vault: { url, password, username?,
  // profileId? }. `updated:true` means the account was already there and its
  // password was replaced rather than a second item created; `linked:true` means
  // this exact credential was already in the vault under another subdomain of
  // the same site, and only its address list grew.
  'save-login': async (ctx, params) => {
    const p = (params ?? {}) as {
      profileId?: unknown
      url?: unknown
      username?: unknown
      password?: unknown
    }
    try {
      const profileId = opt(p.profileId)
      const username = typeof p.username === 'string' ? p.username : undefined
      return {
        ok: true,
        ...(await ctx.saveLogin({
          ...(profileId ? { profileId } : {}),
          url: str(p.url, 'url'),
          ...(username !== undefined ? { username } : {}),
          password: password(p.password)
        }))
      }
    } catch (error) {
      return fail(error)
    }
  },

  // Remove a login from a vault: { id, profileId? }. Soft delete — the item goes
  // to Bitwarden's trash. The id must belong to a LOGIN of that vault, so a wrong
  // id cannot take a card down with it.
  'delete-login': async (ctx, params) => {
    const p = (params ?? {}) as { id?: unknown; profileId?: unknown }
    try {
      return { ok: true, ...(await ctx.deleteLogin(str(p.id, 'id'), opt(p.profileId))) }
    } catch (error) {
      return fail(error)
    }
  }
}
