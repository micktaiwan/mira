// Pure logic for "you just typed a card into a page" — the decisions Mira makes
// before it ever offers to save anything. No Electron, no I/O, so it is fully
// unit-tested (CLAUDE.md "tout testable").
//
// The page-side agent (card-capture-shim.ts) reports whatever it saw in a form;
// everything that turns that raw, UNTRUSTED payload into "a real card worth
// offering to save" lives here: digits-only normalization, the Luhn checksum,
// the brand, the expiry parse, the human label, and the fingerprint used to
// avoid re-asking about a card we already offered.

import { createHash } from 'node:crypto'

/** Card networks Mira names in the prompt. Anything unrecognized is 'card'. */
export type CardBrand =
  'visa' | 'mastercard' | 'amex' | 'discover' | 'diners' | 'jcb' | 'unionpay' | 'card'

/** What the page agent reports: raw strings exactly as typed, plus where. */
export interface CardCapture {
  /** Digits and separators as typed ("4242 4242 4242 4242"). */
  number: string
  /** Expiry as typed ("12/28", "1228", "12 / 2028"…). */
  expiry: string
  /** Name on the card, as typed (may be empty — not every form asks). */
  holder: string
  /** Origin of the TOP-LEVEL page (never the payment iframe's), so the prompt
   * says "on stripe-checkout.example.com" the way the user experiences it. */
  origin: string
}

/** A capture that passed every check, in the shape Bitwarden wants. */
export interface ValidatedCard {
  /** Digits only. */
  number: string
  /** Two digits, "01".."12". */
  expMonth: string
  /** Four digits. */
  expYear: string
  holder: string
  brand: CardBrand
  origin: string
}

/** Digits only. Everything else (spaces, dashes, unicode) is dropped. Pure. */
export function normalizeCardNumber(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\D/g, '') : ''
}

/** The Luhn checksum — the gate that separates "a card number" from "some digits
 * in a numeric field". This is what lets Mira offer to save WITHOUT waiting for a
 * form submission: a 16-digit string that passes Luhn is a card, not a quantity.
 * Requires 12..19 digits (the ISO/IEC 7812 range). Pure. */
export function isLuhnValid(digits: string): boolean {
  if (!/^\d{12,19}$/.test(digits)) return false
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

/** The network a number belongs to, by IIN prefix. Only used for the label and
 * the Bitwarden `brand` field, so an unknown prefix degrades to 'card'. Pure. */
export function cardBrand(digits: string): CardBrand {
  if (/^4/.test(digits)) return 'visa'
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(digits)) return 'mastercard'
  if (/^3[47]/.test(digits)) return 'amex'
  if (/^(6011|65|64[4-9])/.test(digits)) return 'discover'
  if (/^3(0[0-5]|[68])/.test(digits)) return 'diners'
  if (/^35(2[89]|[3-8]\d)/.test(digits)) return 'jcb'
  if (/^62/.test(digits)) return 'unionpay'
  return 'card'
}

/** Bitwarden's own spelling of a brand (its card item shows these verbatim). */
export function bitwardenBrand(brand: CardBrand): string {
  switch (brand) {
    case 'visa':
      return 'Visa'
    case 'mastercard':
      return 'Mastercard'
    case 'amex':
      return 'American Express'
    case 'discover':
      return 'Discover'
    case 'diners':
      return 'Diners Club'
    case 'jcb':
      return 'JCB'
    case 'unionpay':
      return 'UnionPay'
    default:
      return 'Other'
  }
}

/** Parse an expiry as typed into month + 4-digit year, or null when it is not a
 * plausible expiry. Accepts "12/28", "12/2028", "1228", "12 - 2028", and a
 * 2-digit year is read as 20xx (cards do not predate 2000). Month must be 01..12.
 * Pure — no clock here, freshness is checked separately by isExpired. */
export function parseExpiry(raw: unknown): { month: string; year: string } | null {
  if (typeof raw !== 'string') return null
  const digits = raw.replace(/\D/g, '')
  let month: string
  let year: string
  if (digits.length === 4) {
    month = digits.slice(0, 2)
    year = `20${digits.slice(2)}`
  } else if (digits.length === 6) {
    month = digits.slice(0, 2)
    year = digits.slice(2)
  } else {
    return null
  }
  const m = Number(month)
  if (!Number.isInteger(m) || m < 1 || m > 12) return null
  const y = Number(year)
  if (!Number.isInteger(y) || y < 2000 || y > 2099) return null
  return { month, year }
}

/** Whether an expiry is already past, relative to `now`. A card expires at the
 * END of its month, so 12/2026 is still valid all through December 2026. The
 * clock is INJECTED so this stays pure and testable. */
export function isExpired(month: string, year: string, now: Date): boolean {
  const y = Number(year)
  const m = Number(month)
  const nowY = now.getFullYear()
  const nowM = now.getMonth() + 1
  return y < nowY || (y === nowY && m < nowM)
}

/** "Visa 4242" — what the prompt and the Bitwarden item are named. Never the
 * full number: the label ends up in a window title, a log line and an item name,
 * none of which should carry a PAN. Pure. */
export function cardLabel(brand: CardBrand, digits: string): string {
  const last4 = digits.slice(-4)
  const name = brand === 'card' ? 'Card' : bitwardenBrand(brand)
  return `${name} ${last4}`
}

/** A stable id for "this card, this expiry" that does NOT contain the number.
 * Used to remember what was already offered (and declined) so the prompt does not
 * pop again on every keystroke or every checkout retry. SHA-256, truncated —
 * collision risk is irrelevant for a per-session dedup set. Pure. */
export function cardFingerprint(card: {
  number: string
  expMonth: string
  expYear: string
}): string {
  return createHash('sha256')
    .update(`${card.number}|${card.expMonth}|${card.expYear}`)
    .digest('hex')
    .slice(0, 16)
}

/** Coerce the UNTRUSTED capture payload (it crosses from a web page) into a
 * CardCapture, dropping anything malformed. Strings are capped so a hostile page
 * cannot push megabytes through the ipc channel. Pure. */
export function normalizeCapture(payload: unknown): CardCapture {
  const p = (payload ?? {}) as Partial<CardCapture>
  const str = (v: unknown, max: number): string =>
    typeof v === 'string' ? v.slice(0, max).trim() : ''
  return {
    number: str(p.number, 40),
    expiry: str(p.expiry, 20),
    holder: str(p.holder, 120),
    origin: str(p.origin, 300)
  }
}

/** The whole gate, in one place: does this capture deserve a "save this card?"
 * prompt, and if so what exactly would be saved. Returns null when the number
 * fails Luhn, the expiry is unreadable, or the card is already expired (saving a
 * dead card helps nobody). `now` is injected — pure. */
export function validateCapture(capture: CardCapture, now: Date): ValidatedCard | null {
  const number = normalizeCardNumber(capture.number)
  if (!isLuhnValid(number)) return null
  const expiry = parseExpiry(capture.expiry)
  if (!expiry) return null
  if (isExpired(expiry.month, expiry.year, now)) return null
  return {
    number,
    expMonth: expiry.month,
    expYear: expiry.year,
    holder: capture.holder,
    brand: cardBrand(number),
    origin: capture.origin
  }
}
