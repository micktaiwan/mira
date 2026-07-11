// Skill pane domain: the right-side AI panel. Unlike an HTML overlay, this pane
// does NOT float over the page — main shrinks the active WebContentsView to leave
// room for it (like the left tab panel), so there is no piège #3 (see CLAUDE.md).
// Main owns the pane state and pushes it to the chrome, which renders SkillPane to
// match.
//
// The pane holds a CHAT: an ordered list of user/assistant turns. run-prompt
// appends a turn pair (question → answer); run-skill appends one too (the skill
// name → its summary). `status` tracks the in-flight request (loading while the
// engine works, error if it failed). These commands cover the chrome's own needs:
// read the state on mount, close from the ✕, toggle from the toolbar, and clear
// the conversation. All pilotable (socket / MCP).

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'
import type { ChatMessage } from '../llm'

export type { ChatMessage } from '../llm'

/** The state of the right-side AI pane, owned by main and pushed to the chrome.
 * `open: false` means the pane is hidden (its other fields still carry the retained
 * conversation, so reopening it brings the thread back). */
export interface SkillPaneState {
  open: boolean
  /** A short header for the conversation (the first skill/prompt it started with). */
  title: string
  /** idle = nothing in flight (the thread is up to date); loading = the AI is
   * answering the last turn (hourglass); error = `error` holds the failure. */
  status: 'idle' | 'loading' | 'error'
  /** The conversation so far, oldest first. Each turn is a user question or an
   * assistant answer. */
  messages: ChatMessage[]
  /** The failure message, when status is 'error'. */
  error?: string
}

/** A closed, empty pane (no conversation yet). */
export function closedSkillPane(): SkillPaneState {
  return { open: false, title: '', status: 'idle', messages: [] }
}

/** Skill pane capability slice. showSkillPane is what run-skill / run-prompt call
 * to open and grow the pane; the reads/close/clear are for the chrome. */
export interface PaneContext {
  /** Set the pane state (open/fill/error) in the target window: updates the native
   * layout (shrinks the web view when open) and pushes the state to the chrome. */
  showSkillPane: (state: SkillPaneState) => void
  /** Close the pane (restores the web view to full width). */
  closeSkillPane: () => void
  /** The current pane state, for the chrome to render on mount. */
  getSkillPane: () => SkillPaneState
  /** Write text to the OS clipboard (the native edge behind copy-chat). */
  writeClipboard: (text: string) => void
}

/** The most recent assistant answer in a thread, or undefined if none yet. */
function lastAnswer(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return messages[i].text
  }
  return undefined
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
  },

  // Open / close / toggle the pane, keeping its content. The toolbar button uses
  // this to open the pane ANYTIME (even with no prior result — then it shows just
  // the prompt box). `open` omitted → toggle; a boolean forces that state.
  'toggle-skill-pane': (ctx, params) => {
    const { open } = (params ?? {}) as { open?: unknown }
    if (open !== undefined && typeof open !== 'boolean') {
      return { ok: false, error: '"open" must be a boolean' }
    }
    try {
      const pane = ctx.getSkillPane()
      const next = open ?? !pane.open
      ctx.showSkillPane({ ...pane, open: next })
      return { ok: true, open: next }
    } catch (error) {
      return fail(error)
    }
  },

  // Empty the conversation, keeping the pane open. The "Clear chat" button uses
  // this to start a fresh thread; the retained turns and any error are dropped.
  'clear-chat': (ctx) => {
    try {
      const pane = ctx.getSkillPane()
      ctx.showSkillPane({ ...pane, messages: [], status: 'idle', error: undefined })
      return { ok: true, cleared: true }
    } catch (error) {
      return fail(error)
    }
  },

  // Copy the latest assistant answer to the OS clipboard (the "Copy" button).
  // Pilotable too: an agent can pull the last answer out of Mira via the socket.
  'copy-chat': (ctx) => {
    try {
      const answer = lastAnswer(ctx.getSkillPane().messages)
      if (answer === undefined || answer.trim() === '') {
        return { ok: false, error: 'nothing to copy' }
      }
      ctx.writeClipboard(answer)
      return { ok: true, length: answer.length }
    } catch (error) {
      return fail(error)
    }
  },

  // The chat's options bar (below the thread, beside Send): the user drives the
  // model and whether the CLI loads their MCP servers. A partial merge onto the
  // persisted llm config — provider/apiKey (set in Settings) are left untouched —
  // so the very next run-prompt uses the chosen model / MCP policy (chat reads
  // appSettings.llm). Pilotable: an agent can flip the model over the socket.
  'set-chat-options': (ctx, params) => {
    const { model, loadMcp } = (params ?? {}) as { model?: unknown; loadMcp?: unknown }
    if (model !== undefined && typeof model !== 'string') {
      return { ok: false, error: '"model" must be a string' }
    }
    if (loadMcp !== undefined && typeof loadMcp !== 'boolean') {
      return { ok: false, error: '"loadMcp" must be a boolean' }
    }
    try {
      const current = ctx.getSettings().llm
      const next = { ...current }
      // Empty string clears the override (back to the provider's own default).
      if (model !== undefined) {
        if (model.trim() === '') delete next.model
        else next.model = model.trim()
      }
      if (loadMcp !== undefined) next.loadMcp = loadMcp
      const saved = ctx.setLlmConfig(next).llm
      return { ok: true, model: saved.model ?? '', loadMcp: saved.loadMcp === true }
    } catch (error) {
      return fail(error)
    }
  }
}
