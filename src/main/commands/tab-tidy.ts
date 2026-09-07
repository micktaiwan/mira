// Tab-tidy domain: one command that gathers the strip's twins and neighbours.
// The ordering itself is pure and lives in src/main/tab-tidy.ts; this file is
// the bus surface (menu, socket, MCP all go through it).

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'

/** Tab-tidy capability slice. */
export interface TabTidyContext {
  /** Reorder the target window's loose tabs so exact duplicates sit under their
   * first occurrence, and tabs of the same site sit together (grouped by
   * registrable domain, then by host). Pinned tabs and tabs inside a folder do
   * not move; nothing is opened or closed and the active tab is untouched.
   * Returns how many tabs changed position (0 = already tidy). */
  tidyTabs: () => { moved: number }
}

export const tabTidyCommands: CommandMap<CommandContext> = {
  // File ▸ Group Duplicate Tabs.
  'group-duplicate-tabs': (ctx) => {
    try {
      return { ok: true, ...ctx.tidyTabs() }
    } catch (error) {
      return fail(error)
    }
  }
}
