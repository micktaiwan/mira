// Input domain: synthesize a REAL keypress inside a tab's page. This is the
// keyboard counterpart to exec-js — it lets a socket/MCP caller (or an agent)
// drive keyboard-only UIs: archive a Kondo/Superhuman thread with 'e', move with
// j/k, dismiss with Escape. A synthetic DOM KeyboardEvent (isTrusted:false) does
// not reliably trigger those handlers; a CDP-injected key does. See input-keys.ts
// for why, and for the pure name→payload translation.

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'
import type { CdpModifier } from '../input-keys'

/** Input capability slice. */
export interface InputContext {
  /** Send a real keypress (keyDown+keyUp) to a tab's page. With a `tabId`, the
   * tab is looked up across ALL windows (ids are UUIDs); without one, the target
   * window's active tab. `modifiers` hold ctrl/meta/alt/shift for the press.
   * Throws on an unknown/asleep tab, the Settings tab, or no active web page
   * (same resolution errors as exec-js). */
  pressKeyInTab: (key: string, tabId?: string, modifiers?: CdpModifier[]) => Promise<void>
}

const VALID_MODIFIERS = new Set<CdpModifier>(['alt', 'ctrl', 'meta', 'shift'])

export interface PressKeyParams {
  /** KeyboardEvent.key style name: 'e', 'Enter', 'ArrowDown', ' ', … */
  key: string
  /** Optional target tab (from list-tabs); defaults to the active tab. */
  tabId?: string
  /** Modifiers held during the press. */
  modifiers?: CdpModifier[]
}

export const inputCommands: CommandMap<CommandContext> = {
  'press-key': async (ctx, params) => {
    const { key, tabId, modifiers } = (params ?? {}) as Partial<PressKeyParams>
    if (typeof key !== 'string' || key.length === 0) {
      return { ok: false, error: 'missing "key"' }
    }
    if (tabId !== undefined && (typeof tabId !== 'string' || tabId.trim() === '')) {
      return { ok: false, error: 'invalid "tabId"' }
    }
    if (modifiers !== undefined) {
      if (!Array.isArray(modifiers) || modifiers.some((m) => !VALID_MODIFIERS.has(m))) {
        return { ok: false, error: 'invalid "modifiers" (alt|ctrl|meta|shift)' }
      }
    }
    try {
      await ctx.pressKeyInTab(key, tabId, modifiers)
      return { ok: true, result: { key } }
    } catch (error) {
      return fail(error)
    }
  }
}
