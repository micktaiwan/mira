// Form memory: what was typed into an ordinary text field, so the same field can
// be offered back on the next visit. This is the "remember my numéro fiscal"
// feature, NOT card autofill — cards go to Bitwarden (card.ts / bitwarden.ts) and
// are explicitly excluded here, along with passwords and one-time codes.
//
// The MODEL, deliberately close to Firefox's form history and unlike Chrome's
// form-signature machinery:
//   profile -> registrable domain -> field key -> a few remembered values (MRU).
// A field key is its name (or id, or aria-label): the same key on impots.gouv.fr
// and on a subdomain of it share one entry, and no value ever crosses a domain
// or a profile.
//
// Nothing here asks a question: there is no "save this?" bubble. A value typed
// once is remembered, and the page agent offers it back through a native
// <datalist> popup (form-memory-shim.ts). Asking would be the user doing the
// browser's job (CLAUDE.md).
//
// This file is pure and fully unit-tested; the Electron edge (preload, ipc, disk)
// is form-memory-service.ts.

import { classifyField, type FieldAttrs } from './card-capture'
import { isLuhnValid, normalizeCardNumber } from './card'
import { registrableDomain } from './domain'

/** One remembered value for one field. */
export interface RememberedValue {
  value: string
  /** When it was last typed (ms since epoch) — the MRU order of the popup. */
  used: number
  /** How many times it has been typed. Kept for a future ranking; the order is
   * MRU today. */
  count: number
}

/** field key -> its remembered values, most recently used first. */
export type FieldMemory = Record<string, RememberedValue[]>
/** registrable domain -> its fields. */
export type DomainMemory = Record<string, FieldMemory>
/** profile id -> its domains. Nothing is shared between profiles. */
export type FormMemory = Record<string, DomainMemory>

/** Caps. They exist so a runaway page (or a hand-typed novel) cannot grow the
 * store without bound; each one drops the least recently used entry. */
export const MAX_VALUE_LENGTH = 200
export const MIN_VALUE_LENGTH = 2
export const MAX_VALUES_PER_FIELD = 5
export const MAX_FIELDS_PER_DOMAIN = 60
export const MAX_DOMAINS_PER_PROFILE = 300

/** Input types worth remembering: the ones a human types free text into. Anything
 * else (password, hidden, file, checkbox, …) is skipped by omission, so a new
 * exotic type is skipped by default rather than stored by accident. */
const TEXTUAL_TYPES = new Set(['', 'text', 'search', 'tel', 'url', 'email', 'number'])

/** autocomplete tokens that mean "this is a secret, never keep it". Card tokens
 * are handled by classifyField, which knows all of them. */
const SECRET_TOKENS = new Set(['one-time-code', 'current-password', 'new-password'])

/** Field names/labels that mean a secret even when the input is not type=password
 * (sites do use type=text for a "code" box). */
const SECRET_RE =
  /(password|passwd|pwd\b|mot[\s_-]?de[\s_-]?passe|secret|otp\b|one[\s_-]?time|token|captcha)/i

/** The stable key for a field: its name, else its id, else its aria-label,
 * lower-cased and capped. null when the field has no identifier at all — there
 * would be nothing to match it by on the next visit. */
export function fieldKey(attrs: FieldAttrs): string | null {
  for (const candidate of [attrs.name, attrs.id, attrs.ariaLabel]) {
    const key = (candidate ?? '').trim().toLowerCase()
    if (key !== '') return key.slice(0, 120)
  }
  return null
}

/** Whether this field's value may be remembered. Rejects secrets (passwords,
 * one-time codes), anything the card classifier recognizes (that is Bitwarden's
 * job), non-textual inputs, and any value that looks like a card number even in
 * a field that claims to be something else. */
export function shouldRemember(attrs: FieldAttrs, value: string): boolean {
  const type = (attrs.type ?? '').trim().toLowerCase()
  if (!TEXTUAL_TYPES.has(type)) return false

  const tokens = (attrs.autocomplete ?? '').toLowerCase().split(/\s+/)
  if (tokens.some((token) => SECRET_TOKENS.has(token))) return false

  // Cards are stored in Bitwarden, never here — including the security code,
  // which classifyField recognizes only to have it dropped.
  if (classifyField(attrs) !== null) return false

  const text = [attrs.name, attrs.id, attrs.placeholder, attrs.ariaLabel, attrs.label]
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
  if (SECRET_RE.test(text)) return false

  const trimmed = value.trim()
  if (trimmed.length < MIN_VALUE_LENGTH || trimmed.length > MAX_VALUE_LENGTH) return false

  // A field named "reference" holding a valid PAN is still a PAN.
  const digits = normalizeCardNumber(trimmed)
  if (digits.length >= 12 && digits.length <= 19 && isLuhnValid(digits)) return false

  return true
}

/** The domain a value is filed under: the registrable domain of a page url, so
 * cfspart.impots.gouv.fr and www.impots.gouv.fr share their fields. '' when the
 * url is not a real web page (about:blank, a data: url, garbage). */
export function memoryDomain(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    return registrableDomain(parsed.hostname)
  } catch {
    return ''
  }
}

/** The domain a filter names, accepting a bare domain, a hostname or a full url
 * (`impots.gouv.fr`, `cfspart.impots.gouv.fr`, `https://cfspart.impots.gouv.fr/x`
 * all narrow to the same bucket). '' when it names nothing. */
function filterDomain(input: string): string {
  const raw = input.trim()
  if (raw === '') return ''
  try {
    const host = /^[a-z]+:\/\//i.test(raw)
      ? new URL(raw).hostname
      : new URL(`https://${raw}`).hostname
    return registrableDomain(host)
  } catch {
    return registrableDomain(raw)
  }
}

/** Most recently used first. */
function byRecency(a: RememberedValue, b: RememberedValue): number {
  return b.used - a.used
}

/** How recently anything in this field/domain was touched, for LRU pruning. */
function lastUsed(values: RememberedValue[]): number {
  return values.reduce((max, v) => Math.max(max, v.used), 0)
}

/** Keep the `max` most recently used keys of a record, dropping the rest. */
function keepRecent<T>(record: Record<string, T>, max: number, age: (v: T) => number): void {
  const keys = Object.keys(record)
  if (keys.length <= max) return
  const doomed = keys.sort((a, b) => age(record[b]) - age(record[a])).slice(max)
  for (const key of doomed) delete record[key]
}

/** Remember one typed value. Returns a NEW memory; the input is never mutated.
 * Re-typing a known value moves it to the front and bumps its count rather than
 * duplicating it. A blank domain or field key is a no-op. */
export function rememberValue(
  memory: FormMemory,
  params: { profileId: string; domain: string; field: string; value: string; now: number }
): FormMemory {
  const { profileId, domain, field, now } = params
  const value = params.value.trim()
  if (!profileId || !domain || !field || !value) return memory

  const next: FormMemory = { ...memory }
  const domains: DomainMemory = { ...(next[profileId] ?? {}) }
  const fields: FieldMemory = { ...(domains[domain] ?? {}) }
  const existing = fields[field] ?? []

  const previous = existing.find((v) => v.value === value)
  const values = existing.filter((v) => v.value !== value)
  values.push({ value, used: now, count: (previous?.count ?? 0) + 1 })
  values.sort(byRecency)

  fields[field] = values.slice(0, MAX_VALUES_PER_FIELD)
  keepRecent(fields, MAX_FIELDS_PER_DOMAIN, lastUsed)
  domains[domain] = fields
  keepRecent(domains, MAX_DOMAINS_PER_PROFILE, (f) =>
    Object.values(f).reduce((max, values) => Math.max(max, lastUsed(values)), 0)
  )
  next[profileId] = domains
  return next
}

/** What to offer for a field, most recently used first. `prefix` filters
 * case-insensitively on what has been typed so far; an empty prefix returns
 * everything (Chromium's datalist popup does its own filtering, so the shim asks
 * with no prefix — the parameter is here for the socket/CLI). */
export function suggestionsFor(
  memory: FormMemory,
  params: { profileId: string; domain: string; field: string; prefix?: string }
): string[] {
  const values = memory[params.profileId]?.[params.domain]?.[params.field] ?? []
  const prefix = (params.prefix ?? '').trim().toLowerCase()
  return [...values]
    .sort(byRecency)
    .map((v) => v.value)
    .filter((value) => prefix === '' || value.toLowerCase().startsWith(prefix))
}

/** One entry as the socket shows it. */
export interface FormMemoryEntry {
  profileId: string
  domain: string
  field: string
  values: RememberedValue[]
}

/** Flatten the store for reading, newest field first, optionally narrowed to one
 * profile and/or one domain (matched by registrable domain, so passing a full
 * hostname works). */
export function listEntries(
  memory: FormMemory,
  filter: { profileId?: string; domain?: string } = {}
): FormMemoryEntry[] {
  const wantDomain = filter.domain ? filterDomain(filter.domain) : ''
  const entries: FormMemoryEntry[] = []
  for (const [profileId, domains] of Object.entries(memory)) {
    if (filter.profileId && profileId !== filter.profileId) continue
    for (const [domain, fields] of Object.entries(domains)) {
      if (wantDomain && domain !== wantDomain) continue
      for (const [field, values] of Object.entries(fields)) {
        entries.push({ profileId, domain, field, values: [...values].sort(byRecency) })
      }
    }
  }
  return entries.sort((a, b) => lastUsed(b.values) - lastUsed(a.values))
}

/** Forget something: one value, a whole field, a whole domain, or a whole
 * profile — whichever is the narrowest thing named. Returns the new memory and
 * how many values it dropped. */
export function forgetEntries(
  memory: FormMemory,
  filter: { profileId: string; domain?: string; field?: string; value?: string }
): { memory: FormMemory; removed: number } {
  const domains = memory[filter.profileId]
  if (!domains) return { memory, removed: 0 }
  const wantDomain = filter.domain ? filterDomain(filter.domain) : ''

  let removed = 0
  const nextDomains: DomainMemory = {}
  for (const [domain, fields] of Object.entries(domains)) {
    if (wantDomain && domain !== wantDomain) {
      nextDomains[domain] = fields
      continue
    }
    const nextFields: FieldMemory = {}
    for (const [field, values] of Object.entries(fields)) {
      if (filter.field && field !== filter.field.trim().toLowerCase()) {
        nextFields[field] = values
        continue
      }
      const kept = filter.value ? values.filter((v) => v.value !== filter.value) : []
      removed += values.length - kept.length
      if (kept.length > 0) nextFields[field] = kept
    }
    if (Object.keys(nextFields).length > 0) nextDomains[domain] = nextFields
  }

  const next: FormMemory = { ...memory }
  if (Object.keys(nextDomains).length > 0) next[filter.profileId] = nextDomains
  else delete next[filter.profileId]
  return { memory: next, removed }
}

/** Read the store back from disk. Defensive on purpose: a hand-edited or
 * truncated file yields an empty memory rather than an exception at startup, and
 * every value is re-validated against the caps. */
export function parseMemory(raw: unknown): FormMemory {
  const root = raw as { profiles?: unknown } | null
  const profiles = root && typeof root === 'object' ? root.profiles : null
  if (!profiles || typeof profiles !== 'object') return {}

  const memory: FormMemory = {}
  for (const [profileId, domains] of Object.entries(profiles as Record<string, unknown>)) {
    if (!domains || typeof domains !== 'object') continue
    const nextDomains: DomainMemory = {}
    for (const [domain, fields] of Object.entries(domains as Record<string, unknown>)) {
      if (!fields || typeof fields !== 'object') continue
      const nextFields: FieldMemory = {}
      for (const [field, values] of Object.entries(fields as Record<string, unknown>)) {
        if (!Array.isArray(values)) continue
        const kept: RememberedValue[] = []
        for (const entry of values) {
          const v = entry as Partial<RememberedValue>
          if (typeof v?.value !== 'string') continue
          const value = v.value.trim()
          if (value.length < MIN_VALUE_LENGTH || value.length > MAX_VALUE_LENGTH) continue
          kept.push({
            value,
            used: typeof v.used === 'number' && isFinite(v.used) ? v.used : 0,
            count: typeof v.count === 'number' && isFinite(v.count) ? v.count : 1
          })
        }
        if (kept.length > 0) nextFields[field] = kept.sort(byRecency).slice(0, MAX_VALUES_PER_FIELD)
      }
      if (Object.keys(nextFields).length > 0) nextDomains[domain] = nextFields
    }
    if (Object.keys(nextDomains).length > 0) memory[profileId] = nextDomains
  }
  return memory
}

/** The on-disk shape. Versioned so a later format change can migrate rather than
 * guess. */
export function serializeMemory(memory: FormMemory): string {
  return JSON.stringify({ version: 1, profiles: memory }, null, 2)
}
