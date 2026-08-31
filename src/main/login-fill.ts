// Filling a login form FROM the vault — the PURE half: which stored logins match
// the page, which one to use without asking, and what Mira remembers of that
// choice. The Electron edges (the page agent, the ipc, the `bw` read) are
// login-fill-service.ts; the page-side code is login-fill-shim.ts.
//
// This is the mirror image of login-capture.ts, and the asymmetry is the point:
// capture asks a question before it writes a secret, fill answers one before it
// hands a secret to a page. So the rules here are deliberately narrower than
// Bitwarden's own matching:
//   - a candidate must share the page's SITE (registrable domain), never just a
//     word in its name. `lempire.com` never offers itself on `lempire.fr`.
//   - an exact host beats a sibling subdomain, always. Two accounts on
//     `go.tiime.fr` and `apps.tiime.fr` stay two accounts.
//   - when more than one candidate survives and nothing says which, NOTHING is
//     filled. A wrong password typed into a live login form is a lockout, and
//     the caller is told to choose instead.
//
// WHAT NEVER APPEARS HERE: a password in anything a command returns. The vault
// items carry theirs (they are what gets filled), and `redactCandidates` is the
// only way one of them is allowed to leave the main process — same contract as
// redactLogins in bitwarden-login.ts.

import { uriHost, type VaultLogin } from './bitwarden-login'
import { registrableDomain } from './domain'

/** One fillable account as the socket/UI sees it: no password, ever. `exact`
 * says the item lists this very host, as opposed to a sibling subdomain of the
 * same site — it is what makes an ambiguous list readable. */
export interface FillCandidate {
  id: string
  name: string
  username: string
  hosts: string[]
  exact: boolean
}

/** Why `chooseLogin` picked what it picked — or refused to. */
export type FillReason =
  'ok' | 'no-match' | 'unknown-id' | 'unknown-username' | 'ambiguous' | 'no-host'

export interface FillChoice {
  pick: VaultLogin | null
  reason: FillReason
}

/** The host of the page being filled, lower-cased, or '' when the url is not a
 * real web address (about:blank, a devtools page, a malformed string). Pure. */
export function fillHost(url: string): string {
  const raw = (url ?? '').trim()
  if (!raw) return ''
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    return parsed.host.toLowerCase()
  } catch {
    return ''
  }
}

/** True when a vault item carries an address on this exact host. Pure. */
function coversHost(item: VaultLogin, host: string): boolean {
  return item.hosts.some((h) => h === host)
}

/** True when a vault item carries an address on the same site (registrable
 * domain) as `host`, subdomain or not. Pure. */
function coversSite(item: VaultLogin, site: string): boolean {
  return site !== '' && item.hosts.some((h) => registrableDomain(h) === site)
}

/** The vault logins that could fill a form on `host`, best first: the items that
 * list this exact host, then the ones that only share its site. Within a rank,
 * items keep a stable, readable order (by username, then by name) so the same
 * page always offers the same list in the same order.
 *
 * An item with no username is kept — plenty of sites log in with an email typed
 * into a field the vault never recorded, and the password alone is still what
 * the user wants. Pure. */
export function candidatesForHost(items: VaultLogin[], host: string): VaultLogin[] {
  const target = (host ?? '').trim().toLowerCase()
  if (target === '') return []
  const site = registrableDomain(target)
  const exact: VaultLogin[] = []
  const sameSite: VaultLogin[] = []
  for (const item of items) {
    if (coversHost(item, target)) exact.push(item)
    else if (coversSite(item, site)) sameSite.push(item)
  }
  const order = (a: VaultLogin, b: VaultLogin): number =>
    a.username.localeCompare(b.username) || a.name.localeCompare(b.name)
  return [...exact.sort(order), ...sameSite.sort(order)]
}

/** Strip every password before candidates leave the main process. `exact` is
 * recomputed against the host so the caller can tell "this account is filed
 * under this very address" from "this account belongs to the site". Pure. */
export function redactCandidates(items: VaultLogin[], host: string): FillCandidate[] {
  const target = (host ?? '').trim().toLowerCase()
  return items.map(({ id, name, username, hosts }) => ({
    id,
    name,
    username,
    hosts,
    exact: hosts.some((h) => h === target)
  }))
}

/** Which candidate to fill with, given what the caller asked for and what Mira
 * remembers of this site.
 *
 * The order is the order of authority: an explicit id, then an explicit
 * username, then the only candidate there is, then the one used last time on
 * this site. Anything else refuses — `ambiguous` is a real answer, not a
 * failure, and it is what makes the caller show a list.
 *
 * `lastUsedId` only ever breaks a tie between candidates that already matched
 * the page: a remembered id that no longer matches is silently ignored rather
 * than filled, because the vault may have moved on since. Pure. */
export function chooseLogin(
  candidates: VaultLogin[],
  opts: { id?: string; username?: string; lastUsedId?: string | null } = {}
): FillChoice {
  const wantedId = (opts.id ?? '').trim()
  if (wantedId) {
    const pick = candidates.find((item) => item.id === wantedId) ?? null
    return pick ? { pick, reason: 'ok' } : { pick: null, reason: 'unknown-id' }
  }
  const wantedUser = (opts.username ?? '').trim().toLowerCase()
  if (wantedUser) {
    const matches = candidates.filter((item) => item.username.trim().toLowerCase() === wantedUser)
    if (matches.length === 1) return { pick: matches[0], reason: 'ok' }
    if (matches.length === 0) return { pick: null, reason: 'unknown-username' }
    return { pick: null, reason: 'ambiguous' }
  }
  if (candidates.length === 0) return { pick: null, reason: 'no-match' }
  if (candidates.length === 1) return { pick: candidates[0], reason: 'ok' }
  const remembered = (opts.lastUsedId ?? '').trim()
  if (remembered) {
    const pick = candidates.find((item) => item.id === remembered) ?? null
    if (pick) return { pick, reason: 'ok' }
  }
  return { pick: null, reason: 'ambiguous' }
}

// ── what Mira remembers of a choice ────────────────────────────────────────
//
// profile id -> site (registrable domain) -> the vault item id used last time.
// Keyed by SITE and not by host on purpose: choosing an account once on
// `app.example.com` should carry over to `example.com/login`, which is the same
// account in practice. Nothing here is a secret: an item id is a vault handle,
// useless without the vault.

/** profile id -> site -> vault item id. */
export type FillMemory = Record<string, Record<string, string>>

/** How many sites one profile remembers a choice for. Oldest choice drops
 * first — the store exists to save a click, not to be an archive. */
export const MAX_SITES_PER_PROFILE = 300

/** Read the store back from disk, keeping only well-formed entries. A corrupt
 * file costs the remembered choices, never a crash. Pure. */
export function readFillMemory(raw: unknown): FillMemory {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: FillMemory = {}
  for (const [profileId, sites] of Object.entries(raw as Record<string, unknown>)) {
    if (!profileId || !sites || typeof sites !== 'object' || Array.isArray(sites)) continue
    const kept: Record<string, string> = {}
    for (const [site, id] of Object.entries(sites as Record<string, unknown>)) {
      if (typeof id === 'string' && id !== '' && site !== '') kept[site] = id
    }
    if (Object.keys(kept).length > 0) out[profileId] = kept
  }
  return out
}

/** The item id used last time on this site, or null. Pure. */
export function lastFill(memory: FillMemory, profileId: string, site: string): string | null {
  return memory[profileId]?.[site] ?? null
}

/** Record the choice, most-recent last, and drop the oldest site over the cap.
 * Returns a NEW store — the caller decides when to persist it. Pure. */
export function rememberFill(
  memory: FillMemory,
  profileId: string,
  site: string,
  id: string
): FillMemory {
  if (!profileId || !site || !id) return memory
  const sites = { ...(memory[profileId] ?? {}) }
  // Delete before re-adding so the key moves to the end: insertion order IS the
  // recency order, and that is what the cap evicts on.
  delete sites[site]
  sites[site] = id
  const keys = Object.keys(sites)
  if (keys.length > MAX_SITES_PER_PROFILE) {
    for (const stale of keys.slice(0, keys.length - MAX_SITES_PER_PROFILE)) delete sites[stale]
  }
  return { ...memory, [profileId]: sites }
}

/** Forget everything one profile remembers (profile deleted, data cleared).
 * Pure. */
export function forgetFillProfile(memory: FillMemory, profileId: string): FillMemory {
  if (!(profileId in memory)) return memory
  const out = { ...memory }
  delete out[profileId]
  return out
}

// ── what the page agent reports back ───────────────────────────────────────

/** One frame's answer to a fill request. A page can hold several frames with a
 * login form (an SSO widget in an iframe), so every frame answers and the main
 * process merges. */
export interface FrameFillReport {
  /** Correlates the answer with the request; a stale frame answering an old
   * request is dropped rather than counted. */
  token: string
  url: string
  usernameFilled: boolean
  passwordFilled: boolean
  /** How many password inputs the frame saw. >1 means the page is probably a
   * signup or a change-password form, which the caller may want to know. */
  passwordFields: number
}

/** Validate a report coming from a frame. It crosses a trust boundary (the
 * renderer), so anything malformed is dropped rather than repaired. Pure. */
export function readFrameFillReport(payload: unknown): FrameFillReport | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  if (typeof p.token !== 'string' || p.token === '') return null
  return {
    token: p.token,
    url: typeof p.url === 'string' ? p.url : '',
    usernameFilled: p.usernameFilled === true,
    passwordFilled: p.passwordFilled === true,
    passwordFields: typeof p.passwordFields === 'number' ? p.passwordFields : 0
  }
}

/** What the whole tab did, from every frame that answered. Pure. */
export function mergeFillReports(reports: FrameFillReport[]): {
  username: boolean
  password: boolean
  frames: number
  passwordFields: number
} {
  return {
    username: reports.some((r) => r.usernameFilled),
    password: reports.some((r) => r.passwordFilled),
    frames: reports.filter((r) => r.usernameFilled || r.passwordFilled).length,
    passwordFields: reports.reduce((sum, r) => sum + r.passwordFields, 0)
  }
}

/** The site a fill was performed on, for the memory store. Pure. */
export function fillSite(host: string): string {
  return registrableDomain((host ?? '').trim().toLowerCase())
}

/** The host a vault uri points at — re-exported so callers of this module do not
 * have to reach into bitwarden-login for it. Pure. */
export { uriHost }
