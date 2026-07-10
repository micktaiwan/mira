// History domain: reading and clearing the global browsing history.
//
// Recording a visit is NOT a command — it happens natively when a page
// navigates (see wireView / recordVisit in profiles.ts), not through the bus.
// What the bus exposes is the read side (list / search, used by the palette and
// pilotable from the socket / MCP) and clearing it. The list algebra is pure and
// tested in src/main/history-store.ts; this file is only the thin command layer.

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'
import type { HistoryEntry } from '../history-store'

/** History capability slice: read (recent / search) and clear the global list.
 * Every method acts on the app-wide history, not a per-window state. */
export interface HistoryContext {
  /** The `limit` most-recent history entries (most-recent-first). */
  listHistory: (limit: number) => HistoryEntry[]
  /** Entries whose title or url match `query`, best first, capped at `limit`. */
  searchHistory: (query: string, limit: number) => HistoryEntry[]
  /** Wipe the whole history. Returns how many entries were removed. */
  clearHistory: () => { cleared: number }
}

/** Default page size for list-history / search-history when the caller omits one.
 * Bounded so a socket/MCP call can't ask for the entire (up to 5000-entry) list. */
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000

export interface ListHistoryParams {
  limit?: number
}

export interface SearchHistoryParams {
  query: string
  limit?: number
}

function clampLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_LIMIT
  return Math.min(Math.max(Math.floor(limit), 0), MAX_LIMIT)
}

export const historyCommands: CommandMap<CommandContext> = {
  'list-history': (ctx, params) => {
    const { limit } = (params ?? {}) as Partial<ListHistoryParams>
    try {
      const entries = ctx.listHistory(clampLimit(limit))
      return { ok: true, entries }
    } catch (error) {
      return fail(error)
    }
  },

  'search-history': (ctx, params) => {
    const { query, limit } = (params ?? {}) as Partial<SearchHistoryParams>
    if (typeof query !== 'string') {
      return { ok: false, error: 'missing "query"' }
    }
    try {
      const entries = ctx.searchHistory(query, clampLimit(limit))
      return { ok: true, entries }
    } catch (error) {
      return fail(error)
    }
  },

  'clear-history': (ctx) => {
    try {
      const { cleared } = ctx.clearHistory()
      return { ok: true, cleared }
    } catch (error) {
      return fail(error)
    }
  }
}
