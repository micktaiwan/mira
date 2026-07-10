// Settings domain: opening the Settings surface and reading / writing the app
// settings (currently just the home page URL). Kept as commands (not bare UI
// wiring) so they stay pilotable from the socket / MCP like everything else.

import { normalizeInput } from '../url'
import type { AppSettings } from '../settings-store'
import { LLM_PROVIDERS, type LlmConfig, type LlmProvider } from '../llm'
import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'

/** Settings capability slice. */
export interface SettingsContext {
  /** Open the Settings surface (a settings tab in the target window), or focus it
   * if one is already open. */
  openSettings: () => void
  /** The current app settings (home URL, …). */
  getSettings: () => AppSettings
  /** Set the home page URL (already normalized by the command). An empty value
   * clears the home so new tabs open blank. Returns the resulting settings. */
  setHomeUrl: (url: string) => AppSettings
  /** Replace the LLM engine config (provider + optional key/model). Persisted and
   * applied live to the running skills engine. Returns the resulting settings. */
  setLlmConfig: (llm: LlmConfig) => AppSettings
  /** Set the left tab panel width (px). Clamped, persisted, and applied live
   * (relayouts the web view). Returns the resulting settings. */
  setSidebarWidth: (width: number) => AppSettings
  /** Set the right skill pane width (px). Clamped, persisted, applied live. */
  setSkillPaneWidth: (width: number) => AppSettings
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
  // so "example.com" is stored as a real URL. An empty value clears the home so
  // new tabs open blank. Pilotable: usable from the socket / MCP, not only the
  // Settings UI.
  'set-home-url': (ctx, params) => {
    const { url } = (params ?? {}) as Partial<SetHomeUrlParams>
    if (typeof url !== 'string') return { ok: false, error: '"url" must be a string' }
    // Empty input → clear the home (blank new tabs); anything else is normalized.
    const normalized = url.trim() === '' ? '' : normalizeInput(url)
    try {
      const settings = ctx.setHomeUrl(normalized)
      return { ok: true, homeUrl: settings.homeUrl }
    } catch (error) {
      return fail(error)
    }
  },

  // Choose the AI engine skills use (provider + optional key/model). Pilotable:
  // usable from the socket / MCP, not only the Settings UI.
  'set-llm-config': (ctx, params) => {
    const { provider, apiKey, model } = (params ?? {}) as Partial<LlmConfig>
    if (!LLM_PROVIDERS.includes(provider as LlmProvider)) {
      return { ok: false, error: `"provider" must be one of: ${LLM_PROVIDERS.join(', ')}` }
    }
    if (apiKey !== undefined && typeof apiKey !== 'string') {
      return { ok: false, error: '"apiKey" must be a string' }
    }
    if (model !== undefined && typeof model !== 'string') {
      return { ok: false, error: '"model" must be a string' }
    }
    try {
      const settings = ctx.setLlmConfig({ provider: provider as LlmProvider, apiKey, model })
      return { ok: true, llm: settings.llm }
    } catch (error) {
      return fail(error)
    }
  },

  // Resize the left tab panel. The width is clamped by the context (via
  // clampWidth); the chrome sends the drag width, main lays out the web view to
  // match. Pilotable from the socket / MCP too.
  'set-sidebar-width': (ctx, params) => {
    const { width } = (params ?? {}) as { width?: unknown }
    if (typeof width !== 'number') return { ok: false, error: '"width" must be a number' }
    try {
      const settings = ctx.setSidebarWidth(width)
      return { ok: true, sidebarWidth: settings.sidebarWidth }
    } catch (error) {
      return fail(error)
    }
  },

  // Resize the right skill pane (same contract as set-sidebar-width).
  'set-skill-pane-width': (ctx, params) => {
    const { width } = (params ?? {}) as { width?: unknown }
    if (typeof width !== 'number') return { ok: false, error: '"width" must be a number' }
    try {
      const settings = ctx.setSkillPaneWidth(width)
      return { ok: true, skillPaneWidth: settings.skillPaneWidth }
    } catch (error) {
      return fail(error)
    }
  }
}
