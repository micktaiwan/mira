// The command registry core: the shared shapes and the generic builder that
// turns a set of per-domain command maps into one registry. The commands
// themselves live in sibling files (navigation.ts, profiles.ts, settings.ts),
// each self-contained with its own context slice.
//
// Why this split: under the "tout pilotable" principle (see CLAUDE.md) every
// feature is a command, so a single flat registry file becomes the one place
// every session edits at once — a guaranteed merge collision. Here, adding a
// command touches only its domain file; only adding a whole new domain touches
// the composition root (index.ts). This file changes rarely.

/** A minimal view of a webContents — just what navigation commands need.
 * Structural (not the real Electron type) so the registry stays unit-testable. */
export interface NavigableContents {
  loadURL: (url: string) => unknown
  /** Step back in this view's session history (no-op if already at the oldest). */
  goBack: () => unknown
  /** Step forward in this view's session history (no-op if already newest). */
  goForward: () => unknown
  /** Reload the current page (re-fetch and re-render). */
  reload: () => unknown
  /** Current zoom level (Chrome's log scale: 0 = 100%, factor = 1.2^level). */
  getZoomLevel: () => number
  /** Set the zoom level (same log scale as getZoomLevel). */
  setZoomLevel: (level: number) => unknown
}

/** A profile as seen by a command: a stable id and its display label. */
export interface ProfileInfo {
  id: string
  label: string
}

export type CommandResult = { ok: true; [key: string]: unknown } | { ok: false; error: string }

/** A handler over some context slice `C`. Each domain module types its handlers
 * against the composed context (which satisfies every slice), so the maps merge
 * cleanly into one registry. A handler may be async (e.g. import-cookies, which
 * awaits Electron's cookies.set per cookie); most stay synchronous. */
export type CommandHandler<C> = (
  ctx: C,
  params: unknown
) => CommandResult | Promise<CommandResult>

/** A named set of commands sharing a context type. One per domain file. */
export type CommandMap<C> = Record<string, CommandHandler<C>>

/** Turn an unknown thrown value into a `{ ok: false }` result so a command never
 * lets a native error escape the registry. */
export function fail(error: unknown): CommandResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

export interface CommandRegistryOf<C> {
  execute: (name: string, params: unknown, ctx: C) => CommandResult
  has: (name: string) => boolean
  names: () => string[]
}

/** Build a registry from one merged command map. */
export function buildRegistry<C>(commands: CommandMap<C>): CommandRegistryOf<C> {
  return {
    // `execute` is typed as returning a synchronous CommandResult so the many
    // sync callers/tests stay ergonomic. A handful of handlers are async
    // (import-cookies), so the runtime value may actually be a Promise — the
    // transports that can hit those (socket, IPC) await the result, which is a
    // no-op on a plain object. The cast localizes that imprecision here.
    execute(name, params, ctx) {
      const handler = commands[name]
      if (!handler) throw new Error(`Unknown command: ${name}`)
      return handler(ctx, params) as CommandResult
    },
    has(name) {
      return name in commands
    },
    names() {
      return Object.keys(commands)
    }
  }
}
