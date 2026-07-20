// Forget domain: the "wipe everything about this site" deep clean. Two shapes:
//
//   - forget-site (Cmd+Alt+W): acts on the ACTIVE tab's registrable domain.
//     Closes the tab and flashes a toast IMMEDIATELY, then runs the actual wipe
//     (cookies + storage + history, all subdomains) in the BACKGROUND — the UI
//     never blocks on it. A second toast confirms when the wipe finishes.
//   - forget-domain: same wipe for an explicit domain in a profile's session,
//     with NO tab and NO UI dependency (socket/MCP). Awaits and returns counts.
//
// The heavy lifting (session data + history) lives in the native ProfileManager
// (forgetDomainData / forgetActiveSite / forgetDomain, src/main/profiles.ts); the
// domain matching is pure and tested in src/main/domain.ts + history-store.ts.
// This file is the thin command layer, and it owns the toast copy.

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'

/** What a domain wipe removed. */
export interface ForgetCounts {
  cookiesRemoved: number
  historyRemoved: number
}

/** Outcome of forget-site: the tab is already closed and the wipe is running in
 * the background. `done` resolves with the counts once the wipe completes.
 * `null` domain when there was no web page to act on (empty window, Settings
 * tab, or a non-http page) — nothing was cleaned and `done` resolves to zeros. */
export interface ForgetSiteResult {
  domain: string | null
  closed: boolean
  tabId: string | null
  /** Resolves when the background wipe finishes (immediately, to zeros, when
   * there was nothing to forget). */
  done: Promise<ForgetCounts>
}

/** Forget capability slice. */
export interface ForgetContext {
  /** Close the active tab and start wiping its registrable domain (cookies +
   * storage + history, all subdomains) in the background. Returns as soon as the
   * tab is closed; the wipe continues via the `done` promise. */
  forgetActiveSite: () => ForgetSiteResult
  /** Wipe a registrable `domain` (and its subdomains) in a profile's session:
   * cookies + storage + history. No tab, no UI. Defaults to the target window's
   * profile; pass `profileId` to target another. Awaits the full wipe. `domain`
   * is null in the result when the input didn't resolve to a registrable domain. */
  forgetDomain: (
    domain: string,
    profileId?: string
  ) => Promise<ForgetCounts & { domain: string | null }>
}

export const forgetCommands: CommandMap<CommandContext> = {
  // Destructive, but non-blocking: close the active tab NOW, wipe its domain in
  // the background. Toast #1 fires immediately (tab closed, cleaning in bg —
  // wait); toast #2 fires when the wipe completes, with the counts.
  'forget-site': async (ctx) => {
    try {
      const result = ctx.forgetActiveSite()
      if (!result.domain) {
        return { ok: false, error: 'no active site to forget' }
      }
      const domain = result.domain
      ctx.showToast(
        `Tab closed. Clearing ${domain} data in the background — wait a moment before assuming it's gone.`
      )
      // Confirm (or report failure) when the background wipe finishes. Not awaited
      // so the command returns immediately.
      void result.done
        .then(({ cookiesRemoved, historyRemoved }) =>
          ctx.showToast(
            `Cleared ${domain}: ${cookiesRemoved} cookies, ${historyRemoved} history entries removed.`
          )
        )
        .catch(() => ctx.showToast(`Failed to fully clear ${domain} — see logs.`))
      return { ok: true, domain, closed: result.closed, tabId: result.tabId }
    } catch (error) {
      return fail(error)
    }
  },

  // Tab-independent, UI-independent: wipe an explicit domain in a profile. Awaits
  // the full wipe and returns the counts. No toast (this is the programmatic path).
  'forget-domain': async (ctx, params) => {
    const { domain, profileId } = (params ?? {}) as { domain?: string; profileId?: string }
    if (!domain || typeof domain !== 'string') {
      return { ok: false, error: '"domain" is required' }
    }
    try {
      const result = await ctx.forgetDomain(domain, profileId)
      if (!result.domain) return { ok: false, error: `invalid domain: ${domain}` }
      return { ok: true, ...result }
    } catch (error) {
      return fail(error)
    }
  }
}
