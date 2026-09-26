// One Mira window per agent session.
//
// Several Claude Code sessions drive Mira at once. With no explicit target, every
// CLI call used to land on "the focused window's active tab" — the same window
// for everyone, and the one the user is working in. The CLI's own pin ($MIRA_TAB)
// does not help: Claude Code runs each shell command in a fresh shell, so an
// exported variable is gone by the next call.
//
// What IS stable across a session's calls is CLAUDE_CODE_SESSION_ID (Claude Code
// sets it in every command's environment, with CLAUDE_PID for its process). The
// CLI sends it; Mira keeps one window per session id, created on first use and
// ordered in below the user's frontmost window (window-order.ts), and closes it
// on `close-session-window` or once the session's process is gone.
//
// Pure bookkeeping only — no Electron. ProfileManager owns the windows and asks
// this registry which one belongs to whom.

export interface SessionBinding {
  sessionId: string
  /** A session gets one window PER PROFILE: a page must load under the identity
   * it was asked for (the 2026-08-28 bank-page-in-the-work-profile accident). */
  profileId: string
  windowId: string
  /** The agent's process id, when the caller sent one. A session whose process
   * has exited is reaped (its windows closed). Absent → never reaped by pid. */
  pid?: number
}

export type SessionLookup =
  | { windowId: string }
  | { ambiguous: Array<{ windowId: string; profileId: string }> }
  | { none: true }

export class SessionWindowRegistry {
  private bindings: SessionBinding[] = []

  /** The session's window in `profileId`, or — with no profile named — its only
   * open window. Several open windows and no profile is `ambiguous` (the caller
   * must name one, never guess). Bindings whose window the user closed are dropped. */
  lookup(
    sessionId: string,
    profileId: string | undefined,
    isOpen: (windowId: string) => boolean
  ): SessionLookup {
    this.bindings = this.bindings.filter((b) => isOpen(b.windowId))
    const mine = this.bindings.filter(
      (b) => b.sessionId === sessionId && (profileId === undefined || b.profileId === profileId)
    )
    if (mine.length === 0) return { none: true }
    if (mine.length === 1) return { windowId: mine[0].windowId }
    return { ambiguous: mine.map((b) => ({ windowId: b.windowId, profileId: b.profileId })) }
  }

  bind(sessionId: string, profileId: string, windowId: string, pid?: number): void {
    this.bindings = this.bindings.filter(
      (b) => !(b.sessionId === sessionId && b.profileId === profileId)
    )
    this.bindings.push({ sessionId, profileId, windowId, ...(pid ? { pid } : {}) })
  }

  /** Forget a session and return every window it held (for the caller to close). */
  unbind(sessionId: string): string[] {
    const mine = this.bindings.filter((b) => b.sessionId === sessionId).map((b) => b.windowId)
    this.bindings = this.bindings.filter((b) => b.sessionId !== sessionId)
    return mine
  }

  /** Whether a window belongs to some session. Session windows are scratch space:
   * they are never written to the saved session, so a quit never resurrects them. */
  owns(windowId: string): boolean {
    return this.bindings.some((b) => b.windowId === windowId)
  }

  get size(): number {
    return this.bindings.length
  }

  /** Drop every binding whose process has exited or whose window is gone, and
   * return the windows to close (only those whose process died — a window the
   * user already closed needs nothing). */
  reap(isAlive: (pid: number) => boolean, isOpen: (windowId: string) => boolean): string[] {
    const toClose: string[] = []
    this.bindings = this.bindings.filter((b) => {
      if (!isOpen(b.windowId)) return false
      if (b.pid !== undefined && !isAlive(b.pid)) {
        toClose.push(b.windowId)
        return false
      }
      return true
    })
    return toClose
  }
}

/** Which profile a new session window opens in. Never a guess: the profile the
 * caller named; else the only profile with an open window; else (Mira has no
 * window at all) the default one. Several profiles open and none named is an
 * error, the same refusal as `mira open` without a target — a page must not load
 * under the wrong identity. */
export function sessionWindowProfile(opts: {
  requested?: string
  openProfiles: string[]
  fallback: string
}): { profileId: string } | { error: string } {
  if (opts.requested) return { profileId: opts.requested }
  const distinct = [...new Set(opts.openProfiles)]
  if (distinct.length === 0) return { profileId: opts.fallback }
  if (distinct.length === 1) return { profileId: distinct[0] }
  return {
    error:
      `refusing to guess a profile for this session's window: ${distinct.length} profiles are open. ` +
      `Name one with --profile <label|id>.`
  }
}
