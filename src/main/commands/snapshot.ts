// Snapshot domain: read a page as an indexed table of what it lets you do, then
// act on it by ref. `snapshot` lists the elements, `click {ref}` (input.ts)
// clicks one, `type-text` replaces a field's text, `select-option` picks from a
// native dropdown. Every by-ref action is refused when the page moved since the
// snapshot, so an agent never acts on a page it has not seen. The in-page logic
// and the reasons are in ../page-snapshot/page-snapshot.ts.

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'
import {
  groupSnapshot,
  interpretSelect,
  parseRef,
  selectOptionScript,
  snapshotScript
} from '../page-snapshot/page-snapshot'

/** Snapshot capability slice. */
export interface SnapshotContext {
  /** Replace the text of a field named by a snapshot ref: a real CDP click on
   * it, select-all, then CDP text insertion (so React/Vue inputs see real input
   * events). Same tab resolution and visibility guard as clickInTab. Throws
   * with the in-page reason when the ref is stale, hidden, covered or not
   * editable. A null ref skips the click and types into whatever element has
   * focus, iframes included: CDP input goes to the focused frame, which a
   * snapshot (top document only) cannot name. */
  typeInTab: (ref: number | null, text: string, tabId?: string) => Promise<{ target: string }>
}

function tabIdOf(p: Record<string, unknown>): string | undefined | { error: string } {
  if (p.tabId === undefined) return undefined
  if (typeof p.tabId !== 'string' || p.tabId.trim() === '') return { error: 'invalid "tabId"' }
  return p.tabId
}

export const snapshotCommands: CommandMap<CommandContext> = {
  snapshot: async (ctx, params) => {
    const tabId = tabIdOf((params ?? {}) as Record<string, unknown>)
    if (typeof tabId === 'object') return { ok: false, error: tabId.error }
    try {
      const snap = groupSnapshot(await ctx.execJsInTab(snapshotScript(), tabId))
      if ('error' in snap) return { ok: false, error: snap.error }
      return { ok: true, ...snap }
    } catch (error) {
      return fail(error)
    }
  },

  'type-text': async (ctx, params) => {
    const p = (params ?? {}) as Record<string, unknown>
    const focused = p.focused === true
    if (focused && p.ref !== undefined) return { ok: false, error: 'pass "ref" or "focused", not both' }
    const ref = focused ? null : parseRef(p.ref)
    if (ref !== null && typeof ref !== 'number') return { ok: false, error: ref.error }
    if (typeof p.text !== 'string' || p.text.length === 0) {
      return { ok: false, error: '"text" must be a non-empty string' }
    }
    const tabId = tabIdOf(p)
    if (typeof tabId === 'object') return { ok: false, error: tabId.error }
    try {
      const { target } = await ctx.typeInTab(ref, p.text, tabId)
      if (ref === null) return { ok: true, focused: true, target }
      return { ok: true, ref, target }
    } catch (error) {
      return fail(error)
    }
  },

  'select-option': async (ctx, params) => {
    const p = (params ?? {}) as Record<string, unknown>
    const ref = parseRef(p.ref)
    if (typeof ref !== 'number') return { ok: false, error: ref.error }
    const hasValue = typeof p.value === 'string'
    const hasLabel = typeof p.label === 'string' && p.label.length > 0
    if (hasValue === hasLabel) return { ok: false, error: 'pass exactly one of "value" or "label"' }
    const tabId = tabIdOf(p)
    if (typeof tabId === 'object') return { ok: false, error: tabId.error }
    const choice = hasValue ? { value: p.value as string } : { label: p.label as string }
    try {
      const picked = interpretSelect(await ctx.execJsInTab(selectOptionScript(ref, choice), tabId))
      if ('error' in picked) return { ok: false, error: picked.error }
      return { ok: true, ref, ...picked }
    } catch (error) {
      return fail(error)
    }
  }
}
