// The push side of the control socket: who is watching which tab, streamed to
// external subscribers instead of polled.
//
// Everything else on the socket is one request, one response (see socket.ts).
// That shape cannot answer "what is Mickael looking at right now" — a poller
// either misses short visits or burns CPU asking every second, and the browsing
// history is no help after the fact (recordVisit dedups by url, so it keeps a
// visit count and a last-visited stamp, never a duration; see history-store.ts).
// So the feed is a push: subscribers get the current focus on subscribe and one
// line per change afterwards.
//
// Electron-free on purpose, like bookmark-store / history-store: the bus is pure
// and unit-tested, the snapshot is built by the ProfileManager (which owns the
// windows) and handed in.

/** The focused tab, as an outside observer needs it.
 *
 * `folderId` and `profileId` matter as much as the url: a tab folder and a
 * profile are the two groupings the user maintains BY HAND, which makes them the
 * only labels on a page that are certain to mean something. The url alone is
 * ambiguous on the domains that carry the most traffic (mail, calendar, search).
 */
export interface TabFocus {
  /** The window holding the tab (a profile can own several windows). */
  windowId: string
  profileId: string
  profileLabel: string
  tabId: string
  url: string
  title: string
  /** Tab folder the tab sits in, null when loose. Survives a restart: the id is
   * persisted in the session, and each tab keeps its `folderId`. */
  folderId: string | null
  folderTitle: string | null
}

export type FocusListener = (focus: TabFocus | null) => void

/** True when two snapshots describe the same situation. Used to swallow the
 * duplicate publishes that come from Mira's many push paths (a tab strip refresh
 * fires on audio state, loading state, folder collapse…), so a subscriber only
 * ever sees real changes. */
export function sameFocus(a: TabFocus | null, b: TabFocus | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.windowId === b.windowId &&
    a.tabId === b.tabId &&
    a.url === b.url &&
    a.title === b.title &&
    a.folderId === b.folderId &&
    a.folderTitle === b.folderTitle &&
    a.profileId === b.profileId &&
    a.profileLabel === b.profileLabel
  )
}

/**
 * Fan-out of focus changes to socket subscribers.
 *
 * `null` means "no Mira window has the keyboard focus" — the browser is not
 * where the user is. It is a real value, not the absence of one: a subscriber
 * that only ever heard about tabs would keep crediting time to a page left open
 * behind Slack.
 */
export class FocusFeed {
  private listeners = new Set<FocusListener>()
  private last: TabFocus | null = null

  /** The most recent snapshot published (null = Mira is not frontmost). Handed
   * to a new subscriber immediately so it never starts blind. */
  get current(): TabFocus | null {
    return this.last
  }

  /** Register `fn`; returns the unsubscribe. The listener is NOT called on
   * registration — the socket sends the snapshot itself, as its reply to the
   * subscribe request. */
  subscribe(fn: FocusListener): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  get subscriberCount(): number {
    return this.listeners.size
  }

  /** Publish a snapshot. A no-op when nothing changed. A listener that throws
   * must not stop the others, nor bubble into whatever UI action triggered the
   * publish. */
  publish(focus: TabFocus | null): void {
    if (sameFocus(focus, this.last)) return
    this.last = focus
    for (const fn of this.listeners) {
      try {
        fn(focus)
      } catch {
        // A dead socket is the normal case here; drop it.
      }
    }
  }
}
