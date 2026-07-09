// Settings domain: opening the Settings surface and reading / writing the app
// settings (currently just the home page URL). Kept as commands (not bare UI
// wiring) so they stay pilotable from the socket / MCP like everything else.

import { normalizeInput } from '../url'
import type { AppSettings } from '../settings-store'
import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'

/** Settings capability slice. */
export interface SettingsContext {
  /** Open the Settings surface (a settings tab in the target window), or focus it
   * if one is already open. */
  openSettings: () => void
  /** The current app settings (home URL, …). */
  getSettings: () => AppSettings
  /** Set the home page URL (already normalized by the command). Returns the
   * resulting settings (unchanged if the value was empty). */
  setHomeUrl: (url: string) => AppSettings
}

export interface SetHomeUrlParams {
  url: string
}

export const settingsCommands: CommandMap<CommandContext> = {
  'open-settings': (ctx) => {
    try {
      ctx.openSettings()
      return { ok: true }
    } catch (error) {
      return fail(error)
    }
  },

  'get-settings': (ctx) => {
    return { ok: true, ...ctx.getSettings() }
  },

  // Set the home page URL. Normalized like the address bar (bare host → https://…)
  // so "example.com" is stored as a real URL. Pilotable: usable from the socket /
  // MCP, not only the Settings UI.
  'set-home-url': (ctx, params) => {
    const { url } = (params ?? {}) as Partial<SetHomeUrlParams>
    if (typeof url !== 'string') return { ok: false, error: '"url" must be a string' }
    const normalized = normalizeInput(url)
    if (normalized === '') return { ok: false, error: 'empty input' }
    try {
      const settings = ctx.setHomeUrl(normalized)
      return { ok: true, homeUrl: settings.homeUrl }
    } catch (error) {
      return fail(error)
    }
  }
}
