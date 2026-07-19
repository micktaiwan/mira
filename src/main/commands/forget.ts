// Forget domain: the "close this tab and wipe everything about its site" deep
// clean. A single command (Cmd+Alt+W, alongside Cmd+W = close tab and
// Cmd+Shift+W = close window) that, for the active tab's registrable domain:
//   1. clears cookies + origin storage for the domain AND all its subdomains,
//   2. removes every history entry belonging to that domain + subdomains,
//   3. closes the tab,
//   4. flashes a toast confirming the cleanup.
// The heavy lifting (session data + history + tab teardown) lives in the native
// ProfileManager (forgetActiveSite, src/main/profiles.ts); the domain matching
// is pure and tested in src/main/domain.ts + history-store.ts. This file is the
// thin command layer, and it owns the toast copy.

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'

/** Outcome of a deep clean: the registrable domain acted on, what was removed,
 * and the tab that was closed. `null` host when there was no web page to act on
 * (empty window, Settings tab, or a non-http page) — nothing was cleaned. */
export interface ForgetSiteResult {
  domain: string | null
  cookiesRemoved: number
  historyRemoved: number
  closed: boolean
  tabId: string | null
}

/** Forget capability slice. */
export interface ForgetContext {
  /** Deep-clean the active tab's site: wipe cookies + storage + history for its
   * registrable domain (and every subdomain), then close the tab. Returns what
   * was cleaned, or a null-domain result when there is no web page to act on. */
  forgetActiveSite: () => Promise<ForgetSiteResult>
}

export const forgetCommands: CommandMap<CommandContext> = {
  // Destructive: close the active tab and erase every trace of its domain
  // (cookies, storage, history) across all subdomains. No params — always acts
  // on the target window's active tab.
  'forget-site': async (ctx) => {
    try {
      const result = await ctx.forgetActiveSite()
      if (!result.domain) {
        return { ok: false, error: 'no active site to forget' }
      }
      // Confirm the cleanup with a transient pill over the (now closed) page.
      ctx.showToast(`Cleared all data for ${result.domain}`)
      return { ok: true, ...result }
    } catch (error) {
      return fail(error)
    }
  }
}
