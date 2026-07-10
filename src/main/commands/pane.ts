// Skill pane domain: the right-side panel that shows a skill's result (an AI
// summary). Unlike an HTML overlay, this pane does NOT float over the page — main
// shrinks the active WebContentsView to leave room for it (like the left tab
// panel), so there is no piège #3 (see CLAUDE.md). Main owns the pane state and
// pushes it to the chrome, which renders SkillPane to match.
//
// run-skill fills the pane directly via showSkillPane (loading → done/error);
// these commands only cover the chrome's own needs: read the current state on
// mount, and close from the pane's ✕ button. Both are pilotable (socket / MCP).

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'

/** The state of the right-side skill pane, owned by main and pushed to the chrome.
 * `open: false` means the pane is hidden (its other fields are then irrelevant). */
export interface SkillPaneState {
  open: boolean
  /** The running skill's name, shown as the pane header. */
  title: string
  /** loading = the AI is working (hourglass); done = `text` is ready; error =
   * `error` holds the message. */
  status: 'loading' | 'done' | 'error'
  /** The summary, when status is 'done'. */
  text?: string
  /** The failure message, when status is 'error'. */
  error?: string
}

/** A closed, empty pane. */
export function closedSkillPane(): SkillPaneState {
  return { open: false, title: '', status: 'done' }
}

/** Skill pane capability slice. showSkillPane is what run-skill calls to open and
 * fill the pane; the two reads/close are for the chrome. */
export interface PaneContext {
  /** Set the pane state (open/fill/error) in the target window: updates the native
   * layout (shrinks the web view when open) and pushes the state to the chrome. */
  showSkillPane: (state: SkillPaneState) => void
  /** Close the pane (restores the web view to full width). */
  closeSkillPane: () => void
  /** The current pane state, for the chrome to render on mount. */
  getSkillPane: () => SkillPaneState
}

export const paneCommands: CommandMap<CommandContext> = {
  'get-skill-pane': (ctx) => {
    try {
      return { ok: true, pane: ctx.getSkillPane() }
    } catch (error) {
      return fail(error)
    }
  },

  'close-skill-pane': (ctx) => {
    try {
      ctx.closeSkillPane()
      return { ok: true, open: false }
    } catch (error) {
      return fail(error)
    }
  }
}
