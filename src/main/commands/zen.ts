// Zen (focus) mode domain: one toggle that hides ALL of Mira's chrome at once —
// the toolbar (URL bar), the status bar, and BOTH side panels (tab sidebar + AI
// pane). Toggling it back restores the two panels to exactly the state they were
// in before zen (a sidebar that was already closed stays closed).
//
// The hard part is not the bars (main just gives the active WebContentsView the
// whole window height when zen is on) but the panel save/restore. That state
// transition is pure and lives here in `nextZen`, so it is unit-tested without
// Electron; ProfileManager only applies the side effects (collapse/restore the
// panels, re-layout, push the new chrome state to the renderer).

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'

/** The two side panels' visibility, snapshotted on entering zen so exit can put
 * them back. `tabsCollapsed` = left sidebar hidden; `skillPaneOpen` = right AI
 * pane shown. */
export interface PanelSnapshot {
  tabsCollapsed: boolean
  skillPaneOpen: boolean
}

/** Zen mode's own state: whether the chrome is currently hidden, and (while it
 * is) the pre-zen panel state to restore on exit. */
export interface ZenState {
  hidden: boolean
  snapshot: PanelSnapshot | null
}

/** Pure zen transition. Given the current zen state, the LIVE panel state, and a
 * requested target (`undefined` = flip), return the next zen state plus the panel
 * state to apply to the window.
 *
 * - Entering (hidden true): snapshot the live panels, then collapse both (hide
 *   the sidebar, close the AI pane).
 * - Exiting (hidden false): restore the snapshot taken on entry (or leave the
 *   live panels untouched if there was none).
 * - No change (requested === current): keep the zen state and re-assert the live
 *   panels (a harmless no-op the caller can push through unchanged). */
export function nextZen(
  zen: ZenState,
  live: PanelSnapshot,
  requested?: boolean
): { zen: ZenState; apply: PanelSnapshot } {
  const target = requested ?? !zen.hidden
  if (target === zen.hidden) return { zen, apply: live }
  if (target) {
    return {
      zen: { hidden: true, snapshot: { ...live } },
      apply: { tabsCollapsed: true, skillPaneOpen: false }
    }
  }
  const restore = zen.snapshot ?? live
  return { zen: { hidden: false, snapshot: null }, apply: { ...restore } }
}

/** Zen capability slice. `toggleZen` runs the whole episode (bars + both panels)
 * in the target window; `hidden` omitted flips it, a boolean forces the state. */
export interface ZenContext {
  toggleZen: (hidden?: boolean) => { hidden: boolean }
}

export const zenCommands: CommandMap<CommandContext> = {
  // Cmd+Shift+H (and the socket / MCP): hide or show the toolbar, status bar, and
  // both side panels together. `hidden` omitted → toggle; a boolean forces it.
  'toggle-zen': (ctx, params) => {
    const { hidden } = (params ?? {}) as { hidden?: unknown }
    if (hidden !== undefined && typeof hidden !== 'boolean') {
      return { ok: false, error: '"hidden" must be a boolean' }
    }
    try {
      const result = ctx.toggleZen(hidden)
      return { ok: true, hidden: result.hidden }
    } catch (error) {
      return fail(error)
    }
  }
}
