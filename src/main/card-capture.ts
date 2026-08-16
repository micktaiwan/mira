// Recognizing card fields in a page, and assembling one card out of the pieces —
// pure and unit-tested. The page-side agent that reads the DOM is
// card-capture-shim.ts; the Electron wiring is card-capture-service.ts.
//
// TWO things make this harder than "read the form", and both are handled here.
//
//   1. A payment form is often NOT one form. Stripe Elements & co. put the
//      number, the expiry and the CVC in SEPARATE cross-origin iframes, each its
//      own document that cannot see the others. So no frame ever holds a whole
//      card. Each frame reports FRAGMENTS, and the assembly happens per TAB, in
//      the main process — that is what mergeFragment does.
//   2. Half the sites do not set autocomplete="cc-number". So classifyField
//      falls back to matching the field's name / id / placeholder / label, and
//      deliberately errs toward "not a card field": a false negative means no
//      prompt, a false positive means Mira reads a field it had no business
//      reading.
//
// The CVC is classified only so it can be EXCLUDED. Mira never captures it: the
// prompt saves a card, and a stored CVC is exactly what makes a stolen vault
// spendable.

/** What a page field is, as far as cards go. 'cvc' exists to be ignored. */
export type CardFieldKind = 'number' | 'expiry' | 'exp-month' | 'exp-year' | 'holder' | 'cvc'

/** The attributes the page agent reports for one input. All optional: a field
 * may carry nothing but a placeholder. */
export interface FieldAttrs {
  autocomplete?: string
  name?: string
  id?: string
  placeholder?: string
  ariaLabel?: string
  label?: string
  type?: string
  maxLength?: number
}

/** The autocomplete tokens the HTML standard defines for cards. When a site sets
 * one, it is authoritative — no guessing needed. */
const AUTOCOMPLETE_KINDS: Record<string, CardFieldKind> = {
  'cc-number': 'number',
  'cc-exp': 'expiry',
  'cc-exp-month': 'exp-month',
  'cc-exp-year': 'exp-year',
  'cc-name': 'holder',
  'cc-csc': 'cvc'
}

/** Words that mean "this is the security code", checked FIRST because "card
 * code" and "card number" share the word "card". */
const CVC_RE = /(cvc|cvv|csc|cid\b|security[\s_-]?code|card[\s_-]?code|crypto|verification)/i
const NUMBER_RE =
  /(card[\s_-]?number|cardnum|ccnum|cc[\s_-]?number|num[ée]ro[\s_-]?(de[\s_-]?)?carte|pan\b)/i
const EXPIRY_RE =
  /(exp(iry|iration)?[\s_-]?(date)?|valid[\s_-]?(thru|until)|mm[\s_/-]{0,3}(yy|aa))/i
const MONTH_RE = /(exp.*month|month.*exp|mois)/i
const YEAR_RE = /(exp.*year|year.*exp|annee|année)/i
const HOLDER_RE = /(card[\s_-]?holder|name[\s_-]?on[\s_-]?card|titulaire|nom[\s_-]?carte)/i

/** All the free text attached to a field, lowercased into one haystack. */
function haystack(attrs: FieldAttrs): string {
  return [attrs.name, attrs.id, attrs.placeholder, attrs.ariaLabel, attrs.label]
    .filter((v): v is string => typeof v === 'string' && v !== '')
    .join(' ')
}

/** What kind of card field this is, or null when it is not one. The
 * autocomplete attribute wins; otherwise the text around the field decides, CVC
 * first. Pure — the spec the shim string obeys. */
export function classifyField(attrs: FieldAttrs): CardFieldKind | null {
  // A password / hidden / checkbox input is never a card field, whatever it says.
  const type = (attrs.type ?? '').toLowerCase()
  if (type && !['text', 'tel', 'number', 'search', ''].includes(type)) return null

  const tokens = (attrs.autocomplete ?? '').toLowerCase().split(/\s+/)
  for (const token of tokens) {
    const kind = AUTOCOMPLETE_KINDS[token]
    if (kind) return kind
  }

  const text = haystack(attrs)
  if (!text) return null
  if (CVC_RE.test(text)) return 'cvc'
  if (NUMBER_RE.test(text)) return 'number'
  if (MONTH_RE.test(text)) return 'exp-month'
  if (YEAR_RE.test(text)) return 'exp-year'
  if (EXPIRY_RE.test(text)) return 'expiry'
  if (HOLDER_RE.test(text)) return 'holder'
  return null
}

/** One field's value, as reported by one frame. */
export interface CardFragment {
  kind: CardFieldKind
  value: string
  /** The reporting frame's origin (may be a payment iframe, not the site). */
  frameOrigin: string
}

/** What Mira has assembled so far for ONE tab. Values live here in memory only,
 * never on disk, and only until the TTL expires or the prompt is answered. */
export interface CardDraft {
  number: string
  expiry: string
  expMonth: string
  expYear: string
  holder: string
  /** When the most recent fragment landed (epoch ms) — drives the TTL. */
  updatedAt: number
}

export const EMPTY_DRAFT: CardDraft = {
  number: '',
  expiry: '',
  expMonth: '',
  expYear: '',
  holder: '',
  updatedAt: 0
}

/** How long fragments of one card stay assemblable. Long enough to type a number
 * in one iframe and an expiry in another, short enough that a card typed on one
 * site never merges with a field touched on the next. */
export const DRAFT_TTL_MS = 10 * 60 * 1000

/** Fold one fragment into a tab's draft. A stale draft (older than the TTL) is
 * discarded first, so fragments never merge across two unrelated checkouts. The
 * CVC is dropped on the floor — see the file header. Pure: `now` is injected. */
export function mergeFragment(
  draft: CardDraft | undefined,
  fragment: CardFragment,
  now: number
): CardDraft {
  const base = draft && now - draft.updatedAt < DRAFT_TTL_MS ? draft : EMPTY_DRAFT
  if (fragment.kind === 'cvc') return base
  const value = fragment.value.trim()
  if (!value) return base
  const next: CardDraft = { ...base, updatedAt: now }
  switch (fragment.kind) {
    case 'number':
      next.number = value
      break
    case 'expiry':
      next.expiry = value
      break
    case 'exp-month':
      next.expMonth = value
      break
    case 'exp-year':
      next.expYear = value
      break
    case 'holder':
      next.holder = value
      break
  }
  return next
}

/** The expiry as one string, whichever way the site split it. A site with
 * separate month/year selects yields "12/2028"; a single field is passed through
 * as typed. Pure. */
export function draftExpiry(draft: CardDraft): string {
  if (draft.expiry) return draft.expiry
  if (draft.expMonth && draft.expYear) return `${draft.expMonth}/${draft.expYear}`
  return ''
}

/** Is there enough here to be worth validating? Cheap gate before the Luhn pass,
 * and the reason a half-typed number never reaches the prompt. Pure. */
export function draftLooksComplete(draft: CardDraft): boolean {
  const digits = draft.number.replace(/\D/g, '')
  return digits.length >= 12 && draftExpiry(draft) !== ''
}
