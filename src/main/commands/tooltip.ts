// Tooltip domain: show / hide the floating status-bar tooltip. Kept commands
// (not a bare renderer effect) so the overlay is pilotable like everything else
// — and because only main can drive the native overlay window (profiles.ts).
//
// A plain DOM/CSS bubble can't be used here: it would float up into the region
// the tab's WebContentsView covers, and that native layer always paints on top
// of the chrome's DOM (CLAUDE.md, "les deux pièges"). The overlay is a separate
// transparent child window the OS composites above the view. The positioning
// math is pure and tested in ../tooltip; this file only validates params.

import { fail, type CommandMap } from './registry'
import type { CommandContext } from './context'
import type { TooltipRect } from '../tooltip'

/** Tooltip capability slice. `anchor` is the hovered item's client rect (its
 * getBoundingClientRect in the target window); main converts it to screen space. */
export interface TooltipContext {
  showTooltip: (text: string, anchor: TooltipRect) => { shown: boolean }
  hideTooltip: () => { hidden: boolean }
}

export interface ShowTooltipParams {
  text: string
  anchor: TooltipRect
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isRect(v: unknown): v is TooltipRect {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    isFiniteNumber(r.x) &&
    isFiniteNumber(r.y) &&
    isFiniteNumber(r.width) &&
    isFiniteNumber(r.height)
  )
}

export const tooltipCommands: CommandMap<CommandContext> = {
  'show-tooltip': (ctx, params) => {
    const { text, anchor } = (params ?? {}) as Partial<ShowTooltipParams>
    if (typeof text !== 'string' || text.trim() === '')
      return { ok: false, error: 'missing "text"' }
    if (!isRect(anchor)) {
      return { ok: false, error: '"anchor" must have finite x, y, width, height' }
    }
    try {
      const { shown } = ctx.showTooltip(text, anchor)
      return { ok: true, shown }
    } catch (error) {
      return fail(error)
    }
  },

  'hide-tooltip': (ctx) => {
    try {
      const { hidden } = ctx.hideTooltip()
      return { ok: true, hidden }
    } catch (error) {
      return fail(error)
    }
  }
}
