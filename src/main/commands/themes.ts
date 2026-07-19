// Themes domain: list the available chrome themes, author custom ones (name +
// background + text + optional accent/wallpaper), edit/delete them, and assign a
// theme to a profile. The pure model lives in src/main/theme-store.ts; the
// Electron-backed ProfileManager implements the context slice (persists
// themes.json and live-pushes the theme to open windows).

import { type CommandMap, fail, type ProfileInfo } from './registry'
import type { CommandContext } from './context'
import type { Theme } from '../theme-store'

/** Theme capability slice. */
export interface ThemeContext {
  /** Every theme (built-ins first, then custom). */
  listThemes: () => Theme[]
  /** Create a custom theme from its fields; returns the created theme. Throws on
   * invalid input (bad hex, empty name, non-http wallpaper). */
  createTheme: (input: {
    name: string
    background: string
    text: string
    accent?: string | null
    wallpaper?: string | null
  }) => Theme
  /** Patch a custom theme's fields; returns the updated theme. Throws on unknown
   * id or a built-in (immutable). */
  updateTheme: (
    id: string,
    patch: {
      name?: string
      background?: string
      text?: string
      accent?: string | null
      wallpaper?: string | null
    }
  ) => Theme
  /** Delete a custom theme. Throws on a built-in (undeletable). Any profile on
   * the deleted theme falls back to the default. */
  deleteTheme: (id: string) => { id: string }
  /** Assign a theme to a profile (or clear with null → default). Throws on an
   * unknown profile or unknown theme id. */
  setProfileTheme: (id: string, themeId: string | null) => ProfileInfo
}

export interface CreateThemeParams {
  name: string
  background: string
  text: string
  accent?: string | null
  wallpaper?: string | null
}

export interface UpdateThemeParams {
  id: string
  name?: string
  background?: string
  text?: string
  accent?: string | null
  wallpaper?: string | null
}

export interface DeleteThemeParams {
  id: string
}

export interface SetProfileThemeParams {
  id: string
  /** A theme id, or null / '' to clear (fall back to the default theme). */
  themeId: string | null
}

export const themeCommands: CommandMap<CommandContext> = {
  'list-themes': (ctx) => {
    return { ok: true, themes: ctx.listThemes() }
  },

  'create-theme': (ctx, params) => {
    const p = (params ?? {}) as Partial<CreateThemeParams>
    if (typeof p.name !== 'string' || p.name.trim() === '') {
      return { ok: false, error: 'missing "name"' }
    }
    if (typeof p.background !== 'string' || typeof p.text !== 'string') {
      return { ok: false, error: '"background" and "text" are required color strings' }
    }
    try {
      const theme = ctx.createTheme({
        name: p.name,
        background: p.background,
        text: p.text,
        accent: p.accent ?? null,
        wallpaper: p.wallpaper ?? null
      })
      return { ok: true, theme }
    } catch (error) {
      return fail(error)
    }
  },

  'update-theme': (ctx, params) => {
    const p = (params ?? {}) as Partial<UpdateThemeParams>
    if (typeof p.id !== 'string' || p.id.trim() === '') {
      return { ok: false, error: 'missing "id"' }
    }
    try {
      const theme = ctx.updateTheme(p.id.trim(), {
        ...(p.name !== undefined ? { name: p.name } : {}),
        ...(p.background !== undefined ? { background: p.background } : {}),
        ...(p.text !== undefined ? { text: p.text } : {}),
        ...(p.accent !== undefined ? { accent: p.accent } : {}),
        ...(p.wallpaper !== undefined ? { wallpaper: p.wallpaper } : {})
      })
      return { ok: true, theme }
    } catch (error) {
      return fail(error)
    }
  },

  'delete-theme': (ctx, params) => {
    const { id } = (params ?? {}) as Partial<DeleteThemeParams>
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: 'missing "id"' }
    }
    try {
      return { ok: true, ...ctx.deleteTheme(id.trim()) }
    } catch (error) {
      return fail(error)
    }
  },

  'set-profile-theme': (ctx, params) => {
    const { id, themeId } = (params ?? {}) as Partial<SetProfileThemeParams>
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: 'missing "id"' }
    }
    // '' and null both mean "clear" (fall back to the default theme); anything
    // else must be a string naming a theme.
    if (themeId !== undefined && themeId !== null && typeof themeId !== 'string') {
      return { ok: false, error: '"themeId" must be a string or null' }
    }
    try {
      const updated = ctx.setProfileTheme(id.trim(), themeId ? themeId.trim() : null)
      return { ok: true, id: updated.id, themeId: updated.themeId ?? null }
    } catch (error) {
      return fail(error)
    }
  }
}
