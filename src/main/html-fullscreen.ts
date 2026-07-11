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

/** One fullscreen episode: which tab's page is fullscreen, and the panel state
 * to reapply when it ends. */
export interface FullScreenEpisode {
  tabId: string
  restore: PanelSnapshot
}

/** Start an episode: remember the panels as they are right now. */
export function enterFullScreen(tabId: string, current: PanelSnapshot): FullScreenEpisode {
  return { tabId, restore: current }
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
