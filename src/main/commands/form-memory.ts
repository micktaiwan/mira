// Form memory domain: what Mira remembers of the ordinary text fields typed into
// a site, so it can offer the same value back on the next visit (the "numéro
// fiscal" case). NOT cards — those live in Bitwarden, see commands/cards.ts, and
// are explicitly refused by the capture rule.
//
// There is no "save this?" command because there is no such question: a value
// typed once is remembered. What the socket adds on top of the page agent is the
// ability to read the store, forget an entry, and drive both ends of the pipeline
// without a real page (CLAUDE.md "tout pilotable").

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'

/** One remembered value as the socket shows it. */
export interface FormMemoryValueInfo {
  value: string
  used: number
  count: number
}

/** One field's memory on one site. */
export interface FormMemoryEntryInfo {
  profileId: string
  domain: string
  field: string
  values: FormMemoryValueInfo[]
}

/** Form memory capability slice. */
export interface FormMemoryContext {
  /** Everything remembered, optionally narrowed to a profile and/or a site. */
  listFormMemory: (filter: { profileId?: string; domain?: string }) => FormMemoryEntryInfo[]
  /** Forget one value, a field, a site, or a whole profile — the narrowest thing
   * named wins. */
  forgetFormMemory: (filter: {
    profileId?: string
    domain?: string
    field?: string
    value?: string
  }) => { profileId: string; removed: number }
  /** Record a value as if it had been typed on that page. */
  rememberFormValue: (params: {
    profileId?: string
    url: string
    field: string
    value: string
  }) => {
    profileId: string
    domain: string
    field: string
    remembered: boolean
  }
  /** What the popup would offer for that field on that page. */
  suggestFormValues: (params: { profileId?: string; url: string; field: string }) => {
    profileId: string
    domain: string
    field: string
    values: string[]
  }
}

/** Read a required non-empty string param. */
function str(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`"${name}" must be a non-empty string`)
  }
  return value.trim()
}

/** Read an optional string param, absent when blank. */
function opt(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

export const formMemoryCommands: CommandMap<CommandContext> = {
  // What Mira remembers: { profileId?, domain? }. `domain` accepts a bare
  // domain, a hostname or a full url — it is matched by registrable domain.
  'list-form-memory': (ctx, params) => {
    const p = (params ?? {}) as { profileId?: unknown; domain?: unknown }
    try {
      const filter = {
        ...(opt(p.profileId) ? { profileId: opt(p.profileId) as string } : {}),
        ...(opt(p.domain) ? { domain: opt(p.domain) as string } : {})
      }
      return { ok: true, entries: ctx.listFormMemory(filter) }
    } catch (error) {
      return fail(error)
    }
  },

  // Forget: { profileId?, domain?, field?, value? }. With no domain it drops the
  // whole profile's memory, so the narrowing params are the safety.
  'forget-form-memory': (ctx, params) => {
    const p = (params ?? {}) as {
      profileId?: unknown
      domain?: unknown
      field?: unknown
      value?: unknown
    }
    try {
      const filter = {
        ...(opt(p.profileId) ? { profileId: opt(p.profileId) as string } : {}),
        ...(opt(p.domain) ? { domain: opt(p.domain) as string } : {}),
        ...(opt(p.field) ? { field: opt(p.field) as string } : {}),
        ...(opt(p.value) ? { value: opt(p.value) as string } : {})
      }
      return { ok: true, ...ctx.forgetFormMemory(filter) }
    } catch (error) {
      return fail(error)
    }
  },

  // Record a value as if typed: { url, field, value, profileId? }. Same gate as
  // a real page — a password-ish field name or a card number is refused, and
  // `remembered` comes back false.
  'remember-form-value': (ctx, params) => {
    const p = (params ?? {}) as {
      profileId?: unknown
      url?: unknown
      field?: unknown
      value?: unknown
    }
    try {
      return {
        ok: true,
        ...ctx.rememberFormValue({
          ...(opt(p.profileId) ? { profileId: opt(p.profileId) as string } : {}),
          url: str(p.url, 'url'),
          field: str(p.field, 'field'),
          value: str(p.value, 'value')
        })
      }
    } catch (error) {
      return fail(error)
    }
  },

  // What the field would be offered: { url, field, profileId? }.
  'suggest-form-values': (ctx, params) => {
    const p = (params ?? {}) as { profileId?: unknown; url?: unknown; field?: unknown }
    try {
      return {
        ok: true,
        ...ctx.suggestFormValues({
          ...(opt(p.profileId) ? { profileId: opt(p.profileId) as string } : {}),
          url: str(p.url, 'url'),
          field: str(p.field, 'field')
        })
      }
    } catch (error) {
      return fail(error)
    }
  }
}
