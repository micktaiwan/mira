// Audio-history domain: every open tab that has ever emitted sound, most recent
// first. Surfaced in the Settings "Audio" section and pilotable from the socket /
// MCP like every other command.
//
// The timestamp is TabMeta.lastAudibleAt, stamped by the manager on each
// audio-state-changed (start and stop) and persisted with the session, so the
// history survives restarts. A tab playing right now ranks above everything else
// regardless of its stamp. Closing a tab drops it from the history: the list is
// about tabs you can still go back to.

import type { CommandMap } from './registry'
import type { CommandContext } from './context'

/** One open tab that has emitted sound at least once. */
export interface AudioHistoryEntry {
  tabId: string
  profileId: string
  profileLabel: string
  title: string
  url: string
  favicon: string | null
  /** Last time the tab emitted sound (audio start or stop), epoch ms. */
  lastAudibleAt: number
  /** True while the tab is emitting sound right now. */
  audible: boolean
}

/** Audio-history capability slice: every open tab (all open profile windows)
 * carrying a lastAudibleAt stamp, unordered. Native side; injected so it stays
 * mockable. */
export interface AudioHistoryContext {
  listAudioHistory: () => AudioHistoryEntry[]
}

/** Rank most recent first: tabs audible right now on top, then by lastAudibleAt
 * descending, tie-broken by tabId so the order is stable. Pure. */
export function rankAudioHistory(entries: AudioHistoryEntry[]): AudioHistoryEntry[] {
  return [...entries].sort(
    (a, b) =>
      Number(b.audible) - Number(a.audible) ||
      b.lastAudibleAt - a.lastAudibleAt ||
      a.tabId.localeCompare(b.tabId)
  )
}

export const audioHistoryCommands: CommandMap<CommandContext> = {
  'list-audio-history': (ctx) => {
    return { ok: true, entries: rankAudioHistory(ctx.listAudioHistory()) }
  }
}
