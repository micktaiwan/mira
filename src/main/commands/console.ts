// Console domain: read back a tab's captured web-page console — the DevTools
// Console (console.* calls AND browser-emitted lines like failed loads / CORS /
// CSP / uncaught exceptions), tailed into a per-tab ring buffer by profiles.ts
// (see page-console.ts). This is the "what did the page log" primitive over the
// socket/MCP: it lets an agent (or Mickael) see, AFTER THE FACT, why a page
// misbehaved without having had DevTools open — the sibling of exec-js (which
// probes the page live) and extension-console (which tails a SW's console).

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'
import {
  type PageConsoleEntry,
  type PageConsoleQuery,
  isPageLogLevel,
  PAGE_LOG_LEVELS
} from '../page-console'

/** Console capability slice. */
export interface ConsoleContext {
  /** Read a tab's captured console. With a `tabId`, the tab is looked up across
   * ALL windows (UUIDs are global); without one, the target window's active
   * tab. Throws on an unknown/asleep tab, the Settings tab, or no active web
   * page — same resolution semantics as exec-js. */
  readPageConsole: (query: PageConsoleQuery) => PageConsoleEntry[]
}

export const consoleCommands: CommandMap<CommandContext> = {
  // Inspect a tab's web-page console. All params optional:
  //   { tabId?, level?, limit?, sinceSeq? }
  // level floors severity (verbose < info < warning < error); sinceSeq returns
  // only entries newer than a seq (incremental polling).
  'get-console': (ctx, params) => {
    const p = (params ?? {}) as {
      tabId?: unknown
      level?: unknown
      limit?: unknown
      sinceSeq?: unknown
    }
    const query: PageConsoleQuery = {}
    if (p.tabId !== undefined) {
      if (typeof p.tabId !== 'string' || p.tabId.trim() === '') {
        return { ok: false, error: 'invalid "tabId"' }
      }
      query.tabId = p.tabId
    }
    if (p.level !== undefined) {
      if (!isPageLogLevel(p.level)) {
        return { ok: false, error: `"level" must be one of ${PAGE_LOG_LEVELS.join(', ')}` }
      }
      query.minLevel = p.level
    }
    if (p.limit !== undefined) {
      if (typeof p.limit !== 'number' || !Number.isFinite(p.limit) || p.limit <= 0) {
        return { ok: false, error: '"limit" must be a positive number' }
      }
      query.limit = p.limit
    }
    if (p.sinceSeq !== undefined) {
      if (typeof p.sinceSeq !== 'number' || !Number.isFinite(p.sinceSeq) || p.sinceSeq < 0) {
        return { ok: false, error: '"sinceSeq" must be a non-negative number' }
      }
      query.sinceSeq = p.sinceSeq
    }
    try {
      return { ok: true, messages: ctx.readPageConsole(query) }
    } catch (error) {
      return fail(error)
    }
  }
}
