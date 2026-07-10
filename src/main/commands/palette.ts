// Command palette domain: the two commands behind Cmd+K.
//
// - `list-palette` composes the runnable entries from state the chrome already
//   exposes (tabs, favorites, profiles). The building is pure (src/main/palette.ts)
//   and this command only reads existing context slices — so it needs NO new
//   capability of its own beyond `setPaletteOpen`.
// - `toggle-palette` shows / hides the overlay. Because a WebContentsView composites
//   ABOVE the chrome DOM (CLAUDE.md "les deux pièges"), a normal overlay would be
//   hidden behind the page; opening the palette hides the active view (like the
//   Settings tab) so the chrome overlay is visible. That native effect lives behind
//   the PaletteContext slice, implemented by the ProfileManager.

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'
import { buildPaletteEntries } from '../palette'
import { resolveSkills } from '../skills'

/** Palette capability slice. Listing reuses the tabs / bookmarks / profiles slices,
 * so the only new capability is toggling the overlay's visibility. */
export interface PaletteContext {
  /** Open (true), close (false) or toggle (undefined) the palette overlay in the
   * target window. Hides / restores the active web view so the overlay is visible,
   * and notifies the chrome to render / dismiss it. `mode` decides the default
   * target of a picked page: 'launcher' (Cmd+K) opens a new tab, 'address' (typed
   * in the URL bar) navigates the current tab; `query` pre-fills the input. Both
   * only matter when opening. Returns the resulting state. */
  setPaletteOpen: (open?: boolean, mode?: PaletteMode, query?: string) => { open: boolean }
}

/** How the palette was opened, which sets the default target of a page pick.
 * 'launcher' = Cmd+K (a picked page opens in a new tab); 'address' = typed in the
 * URL bar (it navigates the current tab). Cmd+Enter flips it (see CommandPalette). */
export type PaletteMode = 'launcher' | 'address'

export interface TogglePaletteParams {
  open?: boolean
  mode?: PaletteMode
  query?: string
}

/** How many recent history entries to feed the palette candidate set. Bounded so
 * the local fuzzy filter (and the IPC payload) stay cheap even with a big store. */
const PALETTE_HISTORY_LIMIT = 200

export const paletteCommands: CommandMap<CommandContext> = {
  'list-palette': (ctx) => {
    const { tabs, activeId } = ctx.listTabs()
    const { tree } = ctx.listBookmarks()
    const { profiles, focused } = ctx.listProfiles()
    const history = ctx.listHistory(PALETTE_HISTORY_LIMIT)
    // Skills applicable to the active page (empty on Settings / non-web tabs).
    const skills = resolveSkills(ctx.activeUrl() ?? '').map((s) => ({ id: s.id, name: s.name }))
    const entries = buildPaletteEntries({
      tabs: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, kind: t.kind })),
      activeId,
      bookmarks: tree,
      history: history.map((h) => ({ url: h.url, title: h.title })),
      profiles,
      focusedProfile: focused,
      skills
    })
    return { ok: true, entries }
  },

  // Cmd+K toggles (no arg); the chrome passes an explicit `open` to close after a
  // pick / Esc so the two stay in sync regardless of who initiated the change.
  'toggle-palette': (ctx, params) => {
    const { open, mode, query } = (params ?? {}) as Partial<TogglePaletteParams>
    if (open !== undefined && typeof open !== 'boolean') {
      return { ok: false, error: '"open" must be a boolean' }
    }
    if (mode !== undefined && mode !== 'launcher' && mode !== 'address') {
      return { ok: false, error: '"mode" must be "launcher" or "address"' }
    }
    if (query !== undefined && typeof query !== 'string') {
      return { ok: false, error: '"query" must be a string' }
    }
    try {
      const result = ctx.setPaletteOpen(open, mode, query)
      return { ok: true, open: result.open }
    } catch (error) {
      return fail(error)
    }
  }
}
