// Session-window domain: one Mira window per agent session (see
// src/main/session-windows.ts for why). The CLI sends its CLAUDE_CODE_SESSION_ID
// on every call that needs a tab; `session-window` answers with that session's
// own window and its active tab, creating the window on first use — ordered in
// below the user's frontmost window, never activating the app.

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'

export interface SessionWindowContext {
  /** The session's window in `profileId` (else its only one) and its active tab,
   * created on first use — in `profileId`, else the only open profile; several
   * open and none named is refused, never guessed. `pid` is the agent's process:
   * once it exits, Mira closes the session's windows by itself. */
  sessionWindow: (
    sessionId: string,
    opts: { pid?: number; profileId?: string }
  ) => Promise<{ windowId: string; tabId: string | null; created: boolean }>
  /** Close every window of the session. Never quits Mira. */
  closeSessionWindow: (sessionId: string) => { windowIds: string[]; closed: boolean }
}

interface SessionWindowParams {
  sessionId: string
  pid?: number
  profileId?: string
}

function sessionIdOf(params: unknown): string | null {
  const { sessionId } = (params ?? {}) as Partial<SessionWindowParams>
  return typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId.trim() : null
}

export const sessionWindowCommands: CommandMap<CommandContext> = {
  'session-window': async (ctx, params) => {
    const sessionId = sessionIdOf(params)
    if (!sessionId) return { ok: false, error: 'missing "sessionId"' }
    const { pid, profileId } = (params ?? {}) as Partial<SessionWindowParams>
    if (pid !== undefined && !(Number.isInteger(pid) && pid > 0)) {
      return { ok: false, error: '"pid" must be a positive integer' }
    }
    if (profileId !== undefined && (typeof profileId !== 'string' || profileId.trim() === '')) {
      return { ok: false, error: '"profileId" must be a non-empty string' }
    }
    try {
      const result = await ctx.sessionWindow(sessionId, {
        ...(pid !== undefined ? { pid } : {}),
        ...(profileId !== undefined ? { profileId: profileId.trim() } : {})
      })
      return { ok: true, ...result }
    } catch (error) {
      return fail(error)
    }
  },

  'close-session-window': (ctx, params) => {
    const sessionId = sessionIdOf(params)
    if (!sessionId) return { ok: false, error: 'missing "sessionId"' }
    try {
      return { ok: true, ...ctx.closeSessionWindow(sessionId) }
    } catch (error) {
      return fail(error)
    }
  }
}
