// Recognizing a login in a page, and deciding when what was typed is worth
// offering to save — pure and unit-tested. The page-side agent that reads the
// DOM is login-capture-shim.ts; the Electron wiring is login-capture-service.ts.
//
// THREE things make this harder than "read the form", and all three are handled
// here rather than in the shim, so they are testable.
//
//   1. A login is a PAIR, and half the sites split it over two pages (type your
//      email, press Continue, then type your password). No single report ever
//      holds both, so reports are merged per TAB with a TTL — the same trick the
//      card pipeline uses for its cross-origin iframes.
//   2. A password field is not always a login. A signup form has two of them, a
//      change-password form has three, and the confirmation may not match what
//      was typed above. collectLogin resolves those shapes and stays SILENT when
//      they disagree, because saving a mistyped confirmation is worse than not
//      saving at all.
//   3. Offering must wait for INTENT. Cards can be offered as soon as they are
//      complete (Luhn proves it is a card), but half a password typed and
//      abandoned is indistinguishable from a whole one. So nothing is ever
//      offered until the page reports a submit — Enter, the submit button, or a
//      real form submission.
//
// The password itself lives here only in memory, in a per-tab draft that dies
// with the TTL, with the prompt, or with the tab. It is never written anywhere
// but the Bitwarden vault.

import { createHash } from 'node:crypto'
import { registrableDomain } from './domain'
import type { FieldAttrs } from './card-capture'

/** What a page field is, as far as logins go. */
export type LoginFieldKind = 'username' | 'password' | 'new-password'

/** Words that mean "this box holds the account name". Deliberately broad: a
 * false positive costs a wrong username in a prompt the user can refuse, a false
 * negative costs the whole feature on that site. */
const USERNAME_RE =
  /(user[\s_-]?name|username|user\b|login|log[\s_-]?in|e-?mail|mail\b|identifiant|pseudo|compte|account|nickname)/i

/** Words that mean "this is the NEW password" (a signup or a change), as opposed
 * to the one already in use. */
const NEW_PASSWORD_RE =
  /(new|confirm|repeat|retype|verify|again|nouveau|nouvelle|confirmer|r[ée]p[ée]t|v[ée]rif)/i

/** Input types that may hold a username. */
const USERNAME_TYPES = new Set(['', 'text', 'email', 'tel'])

/** All the free text attached to a field, in one haystack. */
function haystack(attrs: FieldAttrs): string {
  return [attrs.name, attrs.id, attrs.placeholder, attrs.ariaLabel, attrs.label]
    .filter((v): v is string => typeof v === 'string' && v !== '')
    .join(' ')
}

/** What kind of login field this is, or null when it is not one. The
 * autocomplete attribute wins when the site sets one; otherwise the type decides
 * for passwords and the text around the field decides for usernames. Pure — this
 * is the spec the shim string mirrors. */
export function classifyLoginField(attrs: FieldAttrs): LoginFieldKind | null {
  const type = (attrs.type ?? '').toLowerCase()
  const tokens = (attrs.autocomplete ?? '').toLowerCase().split(/\s+/)
  const text = haystack(attrs)

  if (type === 'password') {
    if (tokens.includes('new-password')) return 'new-password'
    if (tokens.includes('current-password')) return 'password'
    return NEW_PASSWORD_RE.test(text) ? 'new-password' : 'password'
  }
  if (!USERNAME_TYPES.has(type)) return null
  if (tokens.includes('username') || tokens.includes('email')) return 'username'
  if (type === 'email') return 'username'
  return text && USERNAME_RE.test(text) ? 'username' : null
}

/** One field of a form, as the page agent sees it. */
export interface LoginField {
  attrs: FieldAttrs
  value: string
}

/** The pair a form holds right now, as far as it can be told. `password` is ''
 * when the form has nothing worth saving (nothing typed, or a confirmation that
 * does not match what it confirms). */
export interface CollectedLogin {
  username: string
  password: string
  /** 'new' for a signup / password change, 'current' for a plain login. */
  kind: 'current' | 'new'
  /** Whether the form HAS a username box at all. A form that has one but leaves
   * it empty is half-filled and must wait; a form that has none (the second step
   * of a two-step login, a password-only page) is complete without it. */
  hasUsernameField: boolean
}

/** Resolve a form's fields into the one pair worth saving. Pure — this is the
 * spec the shim mirrors, and where the signup / change-password shapes are
 * decided:
 *
 *   1 filled password        -> that one.
 *   2+ filled passwords      -> the last two must AGREE (new + confirmation, or
 *                               current + new + confirmation). They do not agree
 *                               while the confirmation is half-typed or wrong,
 *                               and then nothing is reported at all. */
export function collectLogin(fields: LoginField[]): CollectedLogin {
  const kinds = fields.map((f) => ({ ...f, kind: classifyLoginField(f.attrs) }))
  const passwords = kinds.filter((f) => f.kind === 'password' || f.kind === 'new-password')
  const usernames = kinds.filter((f) => f.kind === 'username')
  const filled = passwords.filter((f) => f.value !== '')

  let password = ''
  let kind: 'current' | 'new' = 'current'
  if (filled.length === 1) {
    password = filled[0].value
    kind = filled[0].kind === 'new-password' ? 'new' : 'current'
  } else if (filled.length >= 2) {
    const last = filled[filled.length - 1].value
    const previous = filled[filled.length - 2].value
    if (last === previous) {
      password = last
      kind = 'new'
    }
  }

  // The username box that has something in it; failing that, the first one, so
  // "the form has a username field" is still reported.
  const typed = usernames.find((f) => f.value.trim() !== '')
  return {
    username: (typed?.value ?? '').trim(),
    password,
    kind,
    hasUsernameField: usernames.length > 0
  }
}

/** What one frame reports: a pair (either half may be empty), where it was, and
 * whether the user actually tried to log in. */
export interface LoginFragment {
  username: string
  password: string
  kind: 'current' | 'new'
  hasUsernameField: boolean
  /** True when the page saw a submit — a form submission, Enter, or a click on
   * the submit button. NOTHING is ever offered without it. */
  submitted: boolean
  /** The frame's own url, used for the host the login belongs to. */
  url: string
}

/** What Mira has assembled so far for ONE tab. Memory only, never persisted, and
 * dropped as soon as the prompt is answered. */
export interface LoginDraft {
  username: string
  password: string
  kind: 'current' | 'new'
  /** Whether the LAST report came from a form that has a username box. */
  usernameExpected: boolean
  url: string
  /** When the most recent report landed (epoch ms) — drives the TTL. */
  updatedAt: number
}

export const EMPTY_LOGIN_DRAFT: LoginDraft = {
  username: '',
  password: '',
  kind: 'current',
  usernameExpected: false,
  url: '',
  updatedAt: 0
}

/** How long the halves of one login stay assemblable. Long enough to walk
 * through a two-step login (email, Continue, password), short enough that a
 * password typed on one site never pairs with a name typed on the next. */
export const LOGIN_DRAFT_TTL_MS = 10 * 60 * 1000

/** Fold one report into a tab's draft. A stale draft (older than the TTL) is
 * discarded first. An empty half never erases what is already known — that is
 * exactly what carries the username of step 1 into step 2. Pure: `now` is
 * injected. */
export function mergeLoginFragment(
  draft: LoginDraft | undefined,
  fragment: LoginFragment,
  now: number
): LoginDraft {
  const base = draft && now - draft.updatedAt < LOGIN_DRAFT_TTL_MS ? draft : EMPTY_LOGIN_DRAFT
  const username = fragment.username.trim() || base.username
  const password = fragment.password || base.password
  return {
    username,
    password,
    kind: fragment.password ? fragment.kind : base.kind,
    usernameExpected: fragment.hasUsernameField,
    url: fragment.url || base.url,
    updatedAt: now
  }
}

/** Is there a whole login here? A password is required; a username is required
 * only when the form that was just submitted HAS a box for one (otherwise this
 * is the second step of a two-step login, or a password-only page). Pure. */
export function draftComplete(draft: LoginDraft): boolean {
  if (draft.password === '') return false
  return draft.username !== '' || !draft.usernameExpected
}

/** A draft that passed every check, in the shape the vault wants. */
export interface ValidatedLogin {
  username: string
  password: string
  /** The host it belongs to ("banco.mickaelfm.me") — logins are per host, not
   * per registrable domain: two apps on two subdomains are two accounts. */
  host: string
  /** The full page url, stored as the item's uri so Bitwarden matches it back. */
  url: string
  /** True when it came from a signup / password change rather than a login. */
  isNew: boolean
}

/** The shortest thing anyone actually uses as a password. Below this it is a
 * stray keystroke in a password box, not a secret worth a prompt. */
const MIN_PASSWORD = 4
const MAX_PASSWORD = 200
const MAX_USERNAME = 200

/** The whole gate, in one place: does this draft deserve a "save this login?"
 * prompt, and if so what exactly would be saved. Returns null for a page that is
 * not a real web page, a half-typed pair, or a password too short to be one.
 * Pure. */
export function validateLogin(draft: LoginDraft): ValidatedLogin | null {
  if (!draftComplete(draft)) return null
  const password = draft.password
  if (password.trim() === '') return null
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) return null
  let parsed: URL
  try {
    parsed = new URL(draft.url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const host = parsed.host.toLowerCase()
  if (!host) return null
  return {
    username: draft.username.slice(0, MAX_USERNAME),
    password,
    host,
    // The query string of a login page is often a one-shot token; the path is
    // enough to match on and nothing else belongs in a stored uri.
    url: `${parsed.protocol}//${parsed.host}${parsed.pathname}`,
    isNew: draft.kind === 'new'
  }
}

/** A stable id for "this login" that does NOT contain the password itself. Used
 * to remember what was already offered (and declined), so the bubble does not
 * pop again on every retry of the same form. SHA-256, truncated — collisions are
 * irrelevant for a per-run dedup set. Pure. */
export function loginFingerprint(login: {
  host: string
  username: string
  password: string
}): string {
  return createHash('sha256')
    .update(`${login.host}|${login.username.toLowerCase()}|${login.password}`)
    .digest('hex')
    .slice(0, 16)
}

/** What the vault item is called: the site's registrable domain, the way a human
 * names a login ("mickaelfm.me"), never the password. Pure. */
export function loginItemName(host: string): string {
  return registrableDomain(host) || host
}

/** "mickael@x.com on banco.mickaelfm.me" — what the bubble shows. A login with
 * no username degrades to the host alone. Pure. */
export function loginLabel(login: { username: string; host: string }): string {
  return login.username ? `${login.username} on ${login.host}` : login.host
}

/** Coerce the UNTRUSTED report (it crosses from a web page) into a fragment, or
 * null when it is malformed. Every string is capped so a hostile page cannot push
 * megabytes through the channel. Pure — this is the trust boundary. */
export function normalizeLoginFragment(payload: unknown): LoginFragment | null {
  const p = (payload ?? {}) as {
    username?: unknown
    password?: unknown
    kind?: unknown
    hasUsernameField?: unknown
    submitted?: unknown
    url?: unknown
  }
  const str = (value: unknown, max: number): string =>
    typeof value === 'string' ? value.slice(0, max) : ''
  const username = str(p.username, MAX_USERNAME).trim()
  const password = str(p.password, MAX_PASSWORD)
  if (!username && !password) return null
  return {
    username,
    password,
    kind: p.kind === 'new' ? 'new' : 'current',
    hasUsernameField: p.hasUsernameField === true,
    submitted: p.submitted === true,
    url: str(p.url, 2048)
  }
}
