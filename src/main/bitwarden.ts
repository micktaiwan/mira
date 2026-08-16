// Pure logic for talking to the Bitwarden CLI (`bw`) — the ONLY writer Mira uses
// to put a card in a vault. No spawning here; that thin native edge is
// bitwarden-service.ts. Everything decidable without running a process lives in
// this file so it is unit-tested (CLAUDE.md "tout testable").
//
// TWO facts shape this module, both verified against bw 2026.6.0 on 2026-08-13:
//
//   1. `bw create item` accepts its encoded JSON ON STDIN ("Can also be piped
//      into stdin", `bw create --help`). So the card number NEVER appears in a
//      process argument list, where any `ps` on the machine would read it.
//   2. `bw`'s state directory is chosen by BITWARDENCLI_APPDATA_DIR, and each
//      directory is an INDEPENDENT logged-in account. That is what makes "the
//      perso profile writes to the perso account, the pro one never sees it"
//      possible at all — the CLI itself is single-account (verified: the default
//      dir answers as the pro account while ~/.config/bw-perso answers as the
//      perso one).
//
// Consequence for the design: a card vault is identified by an appdata DIRECTORY,
// not by an account name.

import type { ValidatedCard } from './card'
import { bitwardenBrand, cardLabel } from './card'

/** Where one Bitwarden account lives on this machine, from Mira's point of view. */
export interface CardVault {
  /** BITWARDENCLI_APPDATA_DIR for this account (absolute path). */
  appDataDir: string
  /** The account's email, as last reported by `bw status` (display only). */
  email?: string
}

/** What `bw status` says about a vault. 'unauthenticated' = no account logged in
 * that appdata dir; 'locked' = logged in but no usable session; 'unlocked' = the
 * session key we hold is good. */
export type VaultState = 'unauthenticated' | 'locked' | 'unlocked' | 'unknown'

export interface VaultStatus {
  state: VaultState
  email?: string
}

/** A Bitwarden card item, exactly as `bw create item` wants it (type 3). Mirrors
 * `bw get template item` + `bw get template item.card`. */
export interface BitwardenCardItem {
  type: 3
  name: string
  notes: string | null
  favorite: false
  reprompt: 0
  fields: []
  card: {
    cardholderName: string
    brand: string
    number: string
    expMonth: string
    expYear: string
    code: string
  }
}

/** Build the vault item for a validated card. The item NAME carries the brand and
 * the last four only; the origin goes in the notes so a card saved on one shop is
 * recognizable a year later. The CVC is deliberately EMPTY: Mira's page agent
 * never reports it, so there is nothing to write (see card-capture-shim.ts). Pure. */
export function cardItem(card: ValidatedCard, now: Date): BitwardenCardItem {
  const host = originHost(card.origin)
  const savedOn = now.toISOString().slice(0, 10)
  return {
    type: 3,
    name: cardLabel(card.brand, card.number),
    notes: host ? `Saved by Mira on ${host}, ${savedOn}.` : `Saved by Mira on ${savedOn}.`,
    favorite: false,
    reprompt: 0,
    fields: [],
    card: {
      cardholderName: card.holder,
      brand: bitwardenBrand(card.brand),
      number: card.number,
      expMonth: card.expMonth,
      expYear: card.expYear,
      code: ''
    }
  }
}

/** The host of an origin, or '' when it is not a parseable URL. Pure. */
export function originHost(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return ''
  }
}

/** The base64 blob `bw create item` reads. Pure. */
export function encodeItem(item: BitwardenCardItem): string {
  return Buffer.from(JSON.stringify(item), 'utf8').toString('base64')
}

/** The environment for one bw invocation. BITWARDENCLI_APPDATA_DIR picks the
 * account; BW_SESSION supplies the unlocked key. BITWARDENCLI_NOLOGO keeps the
 * banner out of stdout so JSON parses. The caller's PATH etc. are inherited by
 * merging over `base`. Pure. */
export function bwEnv(
  base: NodeJS.ProcessEnv,
  vault: CardVault,
  session?: string | null
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    BITWARDENCLI_APPDATA_DIR: vault.appDataDir,
    BITWARDENCLI_NOLOGO: 'true'
  }
  if (session) env.BW_SESSION = session
  else delete env.BW_SESSION
  return env
}

/** Read `bw status` stdout. bw prints one JSON object; anything else (a prompt, a
 * crash) yields 'unknown' rather than a throw, because the caller must be able to
 * tell the user WHAT is wrong instead of blowing up. Pure. */
export function parseStatus(stdout: string): VaultStatus {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start === -1 || end <= start) return { state: 'unknown' }
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1))
  } catch {
    return { state: 'unknown' }
  }
  const p = (parsed ?? {}) as { status?: unknown; userEmail?: unknown }
  const email = typeof p.userEmail === 'string' ? p.userEmail : undefined
  switch (p.status) {
    case 'unauthenticated':
    case 'locked':
    case 'unlocked':
      return { state: p.status, email }
    default:
      return { state: 'unknown', email }
  }
}

/** Why a bw call failed, in terms Mira's UI can act on. `bw` exits non-zero with
 * a human sentence on stderr; this maps the ones that have a fix. Pure. */
export type BwFailure = 'locked' | 'unauthenticated' | 'not-installed' | 'failed'

export function classifyFailure(stderr: string): BwFailure {
  const text = stderr.toLowerCase()
  if (text.includes('enoent') || text.includes('command not found')) return 'not-installed'
  // invalid_grant: bw's stored refresh token was rejected by the server (it goes
  // stale after weeks without a sync). bw reacts by dropping the account, so the
  // vault is logged OUT, not merely locked, and no master password will help —
  // only `bw login` in that appdata dir will. Seen 2026-08-16 on a slot whose
  // last sync was 34 days old.
  if (text.includes('invalid_grant')) return 'unauthenticated'
  if (text.includes('not logged in')) return 'unauthenticated'
  if (
    text.includes('vault is locked') ||
    text.includes('master password') ||
    text.includes('session key') ||
    text.includes('invalid session')
  ) {
    return 'locked'
  }
  return 'failed'
}

/** One card as Mira reports it back. The full number NEVER leaves the vault:
 * only the last four digits are kept, which is what a human uses to recognize a
 * card and what a leak of this output cannot spend. */
export interface StoredCard {
  id: string
  name: string
  brand: string
  last4: string
  expMonth: string
  expYear: string
  holder: string
}

/** Read `bw list items` output and keep the CARDS (type 3). bw has no
 * server-side type filter, so the whole vault comes back and the filtering
 * happens here. Malformed rows are skipped rather than throwing — one odd item
 * must not hide the rest. Pure. */
export function parseCardItems(stdout: string): StoredCard[] {
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
  const out: StoredCard[] = []
  for (const row of rows) {
    const item = (row ?? {}) as { id?: unknown; name?: unknown; type?: unknown; card?: unknown }
    if (item.type !== 3 || !item.card || typeof item.card !== 'object') continue
    const card = item.card as Record<string, unknown>
    const str = (v: unknown): string => (typeof v === 'string' ? v : '')
    const number = str(card.number)
    out.push({
      id: str(item.id),
      name: str(item.name),
      brand: str(card.brand),
      last4: number.slice(-4),
      expMonth: str(card.expMonth),
      expYear: str(card.expYear),
      holder: str(card.cardholderName)
    })
  }
  return out
}

/** Where the `bw` binary may live, best first.
 *
 * WHY THIS EXISTS: a macOS app launched from the Dock or Finder inherits a
 * MINIMAL PATH (/usr/bin:/bin:/usr/sbin:/sbin) — Homebrew's /opt/homebrew/bin is
 * NOT in it. The same app launched by `open` from a terminal inherits that
 * shell's PATH and finds bw fine, which is exactly how this would have shipped
 * looking healthy and then failed on the next normal launch. So the absolute
 * install paths are tried before falling back to a bare PATH lookup.
 *
 * MIRA_BW_BIN overrides everything, for a bw installed somewhere else. Pure. */
export function bwBinaryCandidates(env: NodeJS.ProcessEnv): string[] {
  const override = env.MIRA_BW_BIN
  return [
    ...(override ? [override] : []),
    '/opt/homebrew/bin/bw',
    '/usr/local/bin/bw',
    '/usr/bin/bw',
    'bw'
  ]
}

/** The id `bw create item` echoes back, so a save can be confirmed and linked.
 * Returns null when stdout is not the expected JSON. Pure. */
export function parseCreatedId(stdout: string): string | null {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1)) as { id?: unknown }
    return typeof parsed.id === 'string' ? parsed.id : null
  } catch {
    return null
  }
}
