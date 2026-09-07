// HTML fullscreen episode: a page element (typically a video) going fullscreen
// inside a tab. While it lasts, both side panels are hidden and the view is
// stretched over the whole window (see layout() in profiles.ts). This module is
// the pure bookkeeping of what to put back on exit:
//
// - entering snapshots the panels' current state;
// - a panel toggled DURING fullscreen overwrites its snapshot entry — the user's
//   last word wins, so exit reapplies what they chose, not the pre-fullscreen state;
// - exiting returns the snapshot to reapply.

/** The two side panels' state: the left tab panel (collapsed?) and the right
 * skill pane (open?). */
export interface PanelSnapshot {
  tabsCollapsed: boolean
  skillPaneOpen: boolean
}

/** One fullscreen episode: which tab's page is fullscreen, the panel state to
 * reapply when it ends, and whether the WINDOW was already in native fullscreen
 * before the page asked. */
export interface FullScreenEpisode {
  tabId: string
  restore: PanelSnapshot
  /** True when the user had already put the window in native (macOS) fullscreen
   * before the page went fullscreen — then the window must STAY fullscreen when
   * the episode ends. False when Chromium fullscreened the window for the page:
   * the window has to be brought back, and nothing else does it. A tab closed
   * mid-video is exactly that case — it emits no `leave-html-full-screen`, so
   * the window used to stay stuck fullscreen with the video gone. */
  windowWasFullScreen: boolean
}

/** Start an episode: remember the panels as they are right now, and whether the
 * window was already fullscreen (so exiting knows whether to bring it back). */
export function enterFullScreen(
  tabId: string,
  current: PanelSnapshot,
  windowWasFullScreen = false
): FullScreenEpisode {
  return { tabId, restore: current, windowWasFullScreen }
}

/** A panel was toggled during the episode: its restore target becomes the new
 * value (last change wins over the pre-fullscreen snapshot). */
export function panelChanged(
  episode: FullScreenEpisode,
  change: Partial<PanelSnapshot>
): FullScreenEpisode {
  return { ...episode, restore: { ...episode.restore, ...change } }
}

/** End the episode: the panel state to reapply. */
export function exitFullScreen(episode: FullScreenEpisode): PanelSnapshot {
  return episode.restore
}

/** Whether ending this episode must also take the WINDOW out of native
 * fullscreen: only when the page is what put it there. */
export function shouldLeaveWindowFullScreen(episode: FullScreenEpisode): boolean {
  return !episode.windowWasFullScreen
}
