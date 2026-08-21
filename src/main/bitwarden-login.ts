// The Bitwarden LOGIN item, pure: what Mira writes when a login is saved, how it
// reads the logins already in a vault, and how it recognizes "this account is
// already in there". No spawning here — that thin native edge is
// bitwarden-service.ts, and the card half of the same protocol is bitwarden.ts.
//
// WHY A SEPARATE FILE FROM bitwarden.ts: a login item is a different type (1 vs
// 3), a different match rule (by host, not by number) and — unlike a card — it
// can be UPDATED in place, which needs the item's full raw JSON. Keeping it here
// also keeps two parallel sessions off the same file (CLAUDE.md, découpage
// anti-collision).
//
// The rule that shapes everything below: a password read out of the vault exists
// only to be COMPARED (is the one just typed already saved?) or to be written
// back. It never reaches a command result — see redactLogins.

import type { ValidatedLogin } from './login-capture'
import { loginItemName } from './login-capture'

/** A Bitwarden login item, as `bw create item` wants it (type 1). Mirrors `bw get
 * template item` + `bw get template item.login`. */
export interface BitwardenLoginItem {
  type: 1
  name: string
  notes: string | null
  favorite: false
  reprompt: 0
  fields: []
  login: {
    username: string
    password: string
    totp: null
    uris: { match: null; uri: string }[]
  }
}

/** Build the vault item for a validated login. The uri is what lets Bitwarden
 * (and Mira's own dedup) match this item back to the site later; the notes say
 * where it came from, so an item found a year later is explainable. Pure. */
export function loginItem(login: ValidatedLogin, now: Date): BitwardenLoginItem {
  const savedOn = now.toISOString().slice(0, 10)
  return {
    type: 1,
    name: loginItemName(login.host),
    notes: `Saved by Mira on ${login.host}, ${savedOn}.`,
    favorite: false,
    reprompt: 0,
    fields: [],
    login: {
      username: login.username,
      password: login.password,
      totp: null,
      uris: [{ match: null, uri: login.url }]
    }
  }
}

/** The base64 blob `bw create item` / `bw edit item` read on stdin. Pure. */
export function encodeBwItem(item: unknown): string {
  return Buffer.from(JSON.stringify(item), 'utf8').toString('base64')
}

/** One login as it exists in the vault, INTERNAL to the main process: it carries
 * the password (needed to answer "is this already saved?") and the untouched raw
 * item (needed to edit it without losing its other fields). Never returned by a
 * command — redactLogins is the only way out. */
export interface VaultLogin {
  id: string
  name: string
  username: string
  password: string
  /** The hosts of the item's uris, lower-cased. */
  hosts: string[]
  /** The item exactly as bw returned it. */
  raw: Record<string, unknown>
}

/** One login as the socket/UI sees it: no password, ever. */
export interface StoredLogin {
  id: string
  name: string
  username: string
  hosts: string[]
}

/** The host of a stored uri, or '' when it is not a url. Bitwarden lets a uri be
 * a bare host or an android:// scheme, so a plain parse failure retries with a
 * https:// prefix before giving up. Pure. */
export function uriHost(uri: string): string {
  const raw = uri.trim()
  if (!raw) return ''
  try {
    return new URL(raw).host.toLowerCase()
  } catch {
    try {
      return new URL(`https://${raw}`).host.toLowerCase()
    } catch {
      return ''
    }
  }
}

/** Read `bw list items` output and keep the LOGINS (type 1). bw has no
 * server-side type filter, so the whole vault comes back and the filtering
 * happens here. Malformed rows are skipped rather than throwing — one odd item
 * must not hide the rest. Pure. */
export function parseLoginItems(stdout: string): VaultLogin[] {
  const start = stdout.indexOf('[')
  const end = stdout.lastIndexOf(']')
  if (start === -1 || end <= start) return []
  let rows: unknown
  try {
    rows = JSON.parse(stdout.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  const out: VaultLogin[] = []
  for (const row of rows) {
    const item = (row ?? {}) as Record<string, unknown>
    if (item.type !== 1 || !item.login || typeof item.login !== 'object') continue
    const login = item.login as Record<string, unknown>
    const str = (v: unknown): string => (typeof v === 'string' ? v : '')
    const uris = Array.isArray(login.uris) ? login.uris : []
    out.push({
      id: str(item.id),
      name: str(item.name),
      username: str(login.username),
      password: str(login.password),
      hosts: uris
        .map((u) => uriHost(str((u as Record<string, unknown> | null)?.uri)))
        .filter((host) => host !== ''),
      raw: item
    })
  }
  return out
}

/** Strip every password before a login leaves the main process. Pure. */
export function redactLogins(items: VaultLogin[]): StoredLogin[] {
  return items.map(({ id, name, username, hosts }) => ({ id, name, username, hosts }))
}

/** The vault item that already holds this account, or null.
 *
 * Matching is by EXACT host plus username (case-insensitive): a login saved for
 * mickaelfm.me is NOT the login for banco.mickaelfm.me, and updating the wrong
 * item would silently destroy a password. When the host matches but the vault
 * item has no username at all, it counts as the same account only if the login
 * being saved has no username either. Pure. */
export function matchLogin(
  items: VaultLogin[],
  target: { host: string; username: string }
): VaultLogin | null {
  const host = target.host.toLowerCase()
  const username = target.username.trim().toLowerCase()
  return (
    items.find(
      (item) => item.hosts.includes(host) && item.username.trim().toLowerCase() === username
    ) ?? null
  )
}

/** The same vault item with a new password, ready to be encoded and sent to `bw
 * edit item`. Everything else (name, uris, custom fields, folder, organization)
 * is carried through untouched — an edit that dropped them would be data loss.
 * Pure. */
export function withNewPassword(item: VaultLogin, password: string): Record<string, unknown> {
  const login = (item.raw.login ?? {}) as Record<string, unknown>
  return { ...item.raw, login: { ...login, password } }
}
