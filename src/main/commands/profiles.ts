// Profiles domain: query the active window's profile and manage the profile set
// (open / create / rename / list). The heavy lifting lives behind the context
// slice — the Electron-backed ProfileManager (src/main/profiles.ts) implements
// it; here we only validate params and shape results.

import { type CommandMap, fail, type ProfileInfo } from './registry'
import type { CommandContext } from './context'

/** Profile capability slice: everything a command can ask about profiles. */
export interface ProfileContext {
  /** The target window's profile, or null if unknown. */
  getTargetProfile: () => ProfileInfo | null
  /** Open the window for an existing profile id, or focus it if already open.
   * Throws if the id is unknown. */
  openProfile: (id: string) => { id: string; created: boolean }
  /** Create a new profile (fresh id + label) and open its window. */
  createProfile: (label?: string) => ProfileInfo
  /** Relabel an existing profile. The id (and its cookies) are untouched.
   * Throws on unknown id or empty label. */
  renameProfile: (id: string, label: string) => ProfileInfo
  /** All known profiles (open or not), each flagged open/closed, plus the id of
   * the currently focused profile. */
  listProfiles: () => {
    profiles: Array<ProfileInfo & { open: boolean }>
    focused: string | null
  }
}

export interface OpenProfileParams {
  id: string
}

export interface CreateProfileParams {
  label?: string
}

export interface RenameProfileParams {
  id: string
  label: string
}

export const profileCommands: CommandMap<CommandContext> = {
  'open-profile': (ctx, params) => {
    const { id } = (params ?? {}) as Partial<OpenProfileParams>
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: 'missing "id"' }
    }
    try {
      const { id: opened, created } = ctx.openProfile(id.trim())
      return { ok: true, id: opened, created }
    } catch (error) {
      return fail(error)
    }
  },

  'create-profile': (ctx, params) => {
    const { label } = (params ?? {}) as Partial<CreateProfileParams>
    if (label !== undefined && typeof label !== 'string') {
      return { ok: false, error: '"label" must be a string' }
    }
    try {
      const { id, label: created } = ctx.createProfile(label?.trim() || undefined)
      return { ok: true, id, label: created }
    } catch (error) {
      return fail(error)
    }
  },

  'rename-profile': (ctx, params) => {
    const { id, label } = (params ?? {}) as Partial<RenameProfileParams>
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: 'missing "id"' }
    }
    if (typeof label !== 'string' || label.trim() === '') {
      return { ok: false, error: 'missing "label"' }
    }
    try {
      const renamed = ctx.renameProfile(id.trim(), label.trim())
      return { ok: true, id: renamed.id, label: renamed.label }
    } catch (error) {
      return fail(error)
    }
  },

  'list-profiles': (ctx) => {
    const { profiles, focused } = ctx.listProfiles()
    return { ok: true, profiles, focused }
  },

  whoami: (ctx) => {
    return { ok: true, profile: ctx.getTargetProfile() }
  }
}
