// Extensions domain: loading, listing and removing Chrome extensions in the
// target window's profile session (extensions are per profile — decision D2,
// extensions-plan.md). The native work (electron-chrome-extensions instances,
// session.extensions calls) lives in src/main/extensions.ts; this file is the
// pilotable command surface plus the pure shaping of what commands return.

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'
import type { CapabilityGap } from '../extension-capabilities'

/** What Mira reports about a loaded extension — the stable, serializable subset
 * of Electron's Extension object (safe to travel over socket/MCP). */
export interface ExtensionInfo {
  id: string
  name: string
  version: string
  /** Absolute path of the unpacked extension directory. */
  path: string
  /** false = paused: unloaded from the session but kept on disk and listed,
   * ready to be re-enabled without reinstalling. */
  enabled: boolean
  /** APIs this extension declares that Mira cannot fully provide (Tier C,
   * extension-capabilities.ts). Omitted when there are none — so a page that
   * loops on a missing API (e.g. Kondo) is diagnosable from list-extensions
   * instead of guesswork. */
  gaps?: CapabilityGap[]
}

/** Shape an Electron Extension (or anything carrying the same fields) into the
 * serializable info commands return. Pure, tested. A live Extension object is
 * by definition loaded, hence the enabled default. */
export function toExtensionInfo(
  ext: {
    id: string
    name: string
    version: string
    path: string
  },
  enabled = true
): ExtensionInfo {
  return { id: ext.id, name: ext.name, version: ext.version, path: ext.path, enabled }
}

/** Extensions capability slice: act on the TARGET window's profile session
 * (install/uninstall are per profile — D2). Native; injected via the command
 * context so it stays mockable. */
export interface ExtensionsContext {
  /** Extensions of the target profile: loaded ones (enabled) plus paused ones
   * from the disabled registry (enabled: false). */
  listExtensions: () => ExtensionInfo[]
  /** Load an unpacked extension directory into the target profile's session and
   * remember it so it reloads at boot. Rejects on a bad path / invalid manifest. */
  loadExtension: (path: string) => Promise<ExtensionInfo>
  /** Install an extension from the Chrome Web Store by id into the target
   * profile's session (downloaded/unpacked under the profile's store dir). */
  installExtension: (id: string) => Promise<ExtensionInfo>
  /** Check the target profile's extensions for Web Store updates, install any. */
  updateExtensions: () => Promise<void>
  /** Pause an extension: unload it from the target profile's session without
   * touching its files, and remember the pause so it survives restarts.
   * Idempotent on an already-paused id; rejects on an unknown id. */
  disableExtension: (id: string) => Promise<ExtensionInfo>
  /** Resume a paused extension: load it back from its directory and forget the
   * pause. Idempotent on an already-enabled id; rejects on an unknown id. */
  enableExtension: (id: string) => Promise<ExtensionInfo>
  /** Remove an extension from the target profile's session (unload + delete its
   * store directory if store-installed + forget any sideload record). Rejects
   * on an unknown id. */
  uninstallExtension: (id: string) => Promise<{ removed: boolean }>
}

export const extensionsCommands: CommandMap<CommandContext> = {
  'list-extensions': (ctx) => {
    try {
      return { ok: true, extensions: ctx.listExtensions() }
    } catch (error) {
      return fail(error)
    }
  },

  'load-extension': async (ctx, params) => {
    const { path } = (params ?? {}) as { path?: unknown }
    if (typeof path !== 'string' || path.trim() === '') {
      return { ok: false, error: '"path" must be a non-empty string' }
    }
    try {
      const extension = await ctx.loadExtension(path)
      return { ok: true, extension }
    } catch (error) {
      return fail(error)
    }
  },

  'install-extension': async (ctx, params) => {
    const { id } = (params ?? {}) as { id?: unknown }
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: '"id" must be a non-empty string' }
    }
    try {
      const extension = await ctx.installExtension(id)
      return { ok: true, extension }
    } catch (error) {
      return fail(error)
    }
  },

  'update-extensions': async (ctx) => {
    try {
      await ctx.updateExtensions()
      return { ok: true }
    } catch (error) {
      return fail(error)
    }
  },

  'disable-extension': async (ctx, params) => {
    const { id } = (params ?? {}) as { id?: unknown }
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: '"id" must be a non-empty string' }
    }
    try {
      const extension = await ctx.disableExtension(id)
      return { ok: true, extension }
    } catch (error) {
      return fail(error)
    }
  },

  'enable-extension': async (ctx, params) => {
    const { id } = (params ?? {}) as { id?: unknown }
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: '"id" must be a non-empty string' }
    }
    try {
      const extension = await ctx.enableExtension(id)
      return { ok: true, extension }
    } catch (error) {
      return fail(error)
    }
  },

  'uninstall-extension': async (ctx, params) => {
    const { id } = (params ?? {}) as { id?: unknown }
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: '"id" must be a non-empty string' }
    }
    try {
      return { ok: true, ...(await ctx.uninstallExtension(id)) }
    } catch (error) {
      return fail(error)
    }
  }
}
