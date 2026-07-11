// Find-in-page domain: search the active tab's page (Cmd+F). The find bar UI
// lives in the chrome's toolbar row — NOT over the page: a DOM overlay there
// would be hidden behind the tab's WebContentsView (CLAUDE.md, "les deux
// pièges"). Chromium does the actual matching/highlighting via
// webContents.findInPage; match counts come back on the 'found-in-page' event,
// which main forwards to the chrome (see wireView in profiles.ts).

import { fail, type CommandMap } from './registry'
import type { CommandContext } from './context'

/** What to do with the highlighted match when the search ends (Electron's
 * stopFindInPage actions). 'clearSelection' is the Esc/close default. */
export type FindStopAction = 'clearSelection' | 'keepSelection' | 'activateSelection'

const STOP_ACTIONS: ReadonlyArray<FindStopAction> = [
  'clearSelection',
  'keepSelection',
  'activateSelection'
]

/** Find capability slice: drive Chromium's find on the active tab. */
export interface FindContext {
  /** Show + focus the find bar in the target window's chrome. */
  openFindBar: () => void
  /** Search the active tab. `newSession` true starts a fresh find session
   * (re-highlights the whole page), false steps the current one — stepping must
   * NOT restart the session or every match gets re-painted (visible flicker).
   * NOTE: Electron's own option is confusingly named the other way around:
   * `findInPage(text, { findNext: true })` BEGINS a new session. The slice uses
   * `newSession` precisely to keep that trap out of the command layer.
   * The text is remembered per window so find-next / find-previous can step the
   * search without the chrome resending it. Throws when the active tab is not a
   * web page. */
  findInPage: (text: string, forward: boolean, newSession: boolean) => void
  /** Step the remembered search. Returns false (a no-op) when no search is
   * active — Cmd+G can fire at any time. */
  findStep: (forward: boolean) => boolean
  /** End the search on the active tab and forget the remembered text. */
  stopFindInPage: (action: FindStopAction) => void
}

export interface FindInPageParams {
  text: string
  /** Search direction; defaults to forward. */
  forward?: boolean
  /** true = step the existing search, false (default) = start a new one. */
  findNext?: boolean
}

export interface FindStopParams {
  action?: FindStopAction
}

export const findCommands: CommandMap<CommandContext> = {
  // Show the find bar in the target window (Cmd+F, palette, socket). The search
  // itself starts when the chrome sends find-in-page with the typed text.
  'find-open': (ctx) => {
    try {
      ctx.openFindBar()
      return { ok: true }
    } catch (error) {
      return fail(error)
    }
  },

  'find-in-page': (ctx, params) => {
    const { text, forward, findNext } = (params ?? {}) as Partial<FindInPageParams>
    if (typeof text !== 'string' || text === '') {
      return { ok: false, error: 'missing "text"' }
    }
    if (forward !== undefined && typeof forward !== 'boolean') {
      return { ok: false, error: '"forward" must be a boolean' }
    }
    if (findNext !== undefined && typeof findNext !== 'boolean') {
      return { ok: false, error: '"findNext" must be a boolean' }
    }
    try {
      // Command semantics: findNext true = step the existing search (follow-up),
      // absent/false = start a new one. Hence newSession is its negation.
      ctx.findInPage(text, forward ?? true, !(findNext ?? false))
      return { ok: true }
    } catch (error) {
      return fail(error)
    }
  },

  // Step the current search (Cmd+G / Cmd+Shift+G, Enter in the find bar).
  // `found:false` when there is no active search — not an error, the
  // accelerators can fire at any time.
  'find-next': (ctx) => {
    try {
      return { ok: true, found: ctx.findStep(true) }
    } catch (error) {
      return fail(error)
    }
  },

  'find-previous': (ctx) => {
    try {
      return { ok: true, found: ctx.findStep(false) }
    } catch (error) {
      return fail(error)
    }
  },

  'find-stop': (ctx, params) => {
    const { action } = (params ?? {}) as Partial<FindStopParams>
    if (action !== undefined && !STOP_ACTIONS.includes(action)) {
      return { ok: false, error: `"action" must be one of ${STOP_ACTIONS.join(', ')}` }
    }
    try {
      ctx.stopFindInPage(action ?? 'clearSelection')
      return { ok: true }
    } catch (error) {
      return fail(error)
    }
  }
}
