// Magnifier domain: the persistent optical zoom of the active tab (Cmd+scroll to
// zoom on the cursor, scroll to pan, back to 100% restores clicks). The zoom/pan
// math is pure and tested in ../magnifier; this file validates params, threads
// the per-view state, and delegates the native effect (CDP clip, flash) to the
// context slice. See the "tout pilotable" principle: these are real commands, so
// the same zoom is reachable from IPC, socket and MCP, not just the trackpad.

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'
import { type MagnifierState, isMagnified, zoomAt, panBy } from '../magnifier'

/** Magnifier capability slice. The state lives per content-view id; the native
 * side applies the CDP clip and runs the flash. */
export interface MagnifierContext {
  /** The view this command targets: its stable id and surface size (CSS px), or
   * null when there is no magnifiable web view (empty window, Settings tab). */
  magnifierTarget: () => { id: string; width: number; height: number } | null
  getMagnifierState: (id: string) => MagnifierState
  setMagnifierState: (id: string, state: MagnifierState) => void
  /** Apply the state to the view natively: set the device-metrics viewport clip
   * (or clear it when not magnified) and toggle the input shim accordingly. */
  applyMagnifierClip: (id: string, state: MagnifierState) => void
  /** Flash the "back to 100%, clicks reliable" frame over the page. */
  magnifierFlash: (id: string) => void
}

interface ZoomParams {
  deltaY: number
  cursorX: number
  cursorY: number
}
interface PanParams {
  deltaX: number
  deltaY: number
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export const magnifierCommands: CommandMap<CommandContext> = {
  // Cmd+scroll: zoom the active tab, anchored on the cursor. cursorX/cursorY are
  // surface CSS px (== the shim's clientX/clientY, since input isn't remapped).
  'magnifier-zoom': (ctx, params) => {
    const { deltaY, cursorX, cursorY } = (params ?? {}) as Partial<ZoomParams>
    if (!num(deltaY) || !num(cursorX) || !num(cursorY)) {
      return { ok: false, error: '"deltaY", "cursorX", "cursorY" must be numbers' }
    }
    const target = ctx.magnifierTarget()
    if (!target) return { ok: false, error: 'no magnifiable view' }
    try {
      const prev = ctx.getMagnifierState(target.id)
      const next = zoomAt(prev, cursorX, cursorY, deltaY, target.width, target.height)
      ctx.setMagnifierState(target.id, next)
      ctx.applyMagnifierClip(target.id, next)
      // Zooming back down to 100% is the deliberate exit: flash so the user knows
      // clicks are reliable again.
      if (isMagnified(prev) && !isMagnified(next)) ctx.magnifierFlash(target.id)
      return { ok: true, scale: next.scale, magnified: isMagnified(next) }
    } catch (error) {
      return fail(error)
    }
  },

  // Plain scroll while magnified: pan the loupe. A no-op (no clip change) when
  // not magnified — the shim only forwards scroll in that case anyway.
  'magnifier-pan': (ctx, params) => {
    const { deltaX, deltaY } = (params ?? {}) as Partial<PanParams>
    if (!num(deltaX) || !num(deltaY)) {
      return { ok: false, error: '"deltaX", "deltaY" must be numbers' }
    }
    const target = ctx.magnifierTarget()
    if (!target) return { ok: false, error: 'no magnifiable view' }
    try {
      const prev = ctx.getMagnifierState(target.id)
      const next = panBy(prev, deltaX, deltaY, target.width, target.height)
      ctx.setMagnifierState(target.id, next)
      ctx.applyMagnifierClip(target.id, next)
      return { ok: true, magnified: isMagnified(next) }
    } catch (error) {
      return fail(error)
    }
  },

  // Snap back to 100% (e.g. from a menu or the socket). Flashes if it was zoomed.
  'magnifier-reset': (ctx) => {
    const target = ctx.magnifierTarget()
    if (!target) return { ok: false, error: 'no magnifiable view' }
    try {
      const was = isMagnified(ctx.getMagnifierState(target.id))
      const next: MagnifierState = { scale: 1, originX: 0, originY: 0 }
      ctx.setMagnifierState(target.id, next)
      ctx.applyMagnifierClip(target.id, next)
      if (was) ctx.magnifierFlash(target.id)
      return { ok: true, scale: 1, magnified: false }
    } catch (error) {
      return fail(error)
    }
  },

  'magnifier-state': (ctx) => {
    const target = ctx.magnifierTarget()
    if (!target) return { ok: false, error: 'no magnifiable view' }
    const state = ctx.getMagnifierState(target.id)
    return { ok: true, ...state, magnified: isMagnified(state) }
  }
}
