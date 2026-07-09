// The command registry: the single source of truth for every Mira action.
// The UI (via IPC), an external unix socket, and an MCP server all reach these
// same commands. See the "tout pilotable" principle in CLAUDE.md.
//
// Commands hold as little Electron as possible: the testable logic lives in
// pure helpers (e.g. normalizeInput), and the command only does the thin native
// call through the CommandContext. The context is built per invocation by the
// transport, so it can bind to the right target window (IPC: the sender window;
// socket: the focused window). That keeps the registry unit-testable with a
// fake context.

import { normalizeInput } from './url'

/** A minimal view of a webContents — just what the commands need. Keeping it
 * structural (not the real Electron type) is what makes the registry testable. */
export interface NavigableContents {
  loadURL: (url: string) => unknown
}

export interface CommandContext {
  /** Content webContents of the window this command targets. Throws if there is
   * no target window (e.g. a socket request with no window open). */
  getTargetWebContents: () => NavigableContents
  /** Profile name of the target window, or null if unknown. */
  getTargetProfile: () => string | null
  /** Open a window for the named profile, or focus it if already open. */
  openProfile: (name: string) => { profile: string; created: boolean }
  /** Known (open) profiles and which one is focused. */
  listProfiles: () => { profiles: string[]; focused: string | null }
}

export interface NavigateParams {
  url: string
}

export interface OpenProfileParams {
  name: string
}

export type CommandResult = { ok: true; [key: string]: unknown } | { ok: false; error: string }

export type CommandHandler = (ctx: CommandContext, params: unknown) => CommandResult

const commands: Record<string, CommandHandler> = {
  navigate: (ctx, params) => {
    const { url } = (params ?? {}) as Partial<NavigateParams>
    const normalized = normalizeInput(url ?? '')
    if (normalized === '') return { ok: false, error: 'empty input' }
    ctx.getTargetWebContents().loadURL(normalized)
    return { ok: true, url: normalized }
  },

  'open-profile': (ctx, params) => {
    const { name } = (params ?? {}) as Partial<OpenProfileParams>
    if (typeof name !== 'string' || name.trim() === '') {
      return { ok: false, error: 'missing "name"' }
    }
    const { profile, created } = ctx.openProfile(name.trim())
    return { ok: true, profile, created }
  },

  'list-profiles': (ctx) => {
    const { profiles, focused } = ctx.listProfiles()
    return { ok: true, profiles, focused }
  },

  whoami: (ctx) => {
    return { ok: true, profile: ctx.getTargetProfile() }
  }
}

export interface CommandRegistry {
  execute: (name: string, params: unknown, ctx: CommandContext) => CommandResult
  has: (name: string) => boolean
  names: () => string[]
}

export function createCommandRegistry(): CommandRegistry {
  return {
    execute(name, params, ctx) {
      const handler = commands[name]
      if (!handler) throw new Error(`Unknown command: ${name}`)
      return handler(ctx, params)
    },
    has(name) {
      return name in commands
    },
    names() {
      return Object.keys(commands)
    }
  }
}
