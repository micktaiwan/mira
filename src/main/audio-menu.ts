// The drop-down shown by the toolbar's audio button: the audio history, i.e. the
// last tabs that emitted sound (all open profiles), most recent first, each with
// "playing now" or how long ago it sounded. It answers "which tab just beeped?"
// for notification sounds that stop before you look. Like tab-menu.ts, the popup
// itself is thin and NATIVE (in profiles.ts) — a CSS popover over the toolbar
// would be clipped by the WebContentsView (main-native-gotchas.md #3), and a
// native menu always composites above it. This pure, testable function decides
// WHICH items to show.
//
// Each entry is an `activate-tab` command carrying its tab id, so clicking it
// routes through the same registry bus as everything else ("tout pilotable") and
// brings that tab to the front, even in another profile's window. With no history
// the menu shows a single disabled placeholder.

import { rankAudioHistory, type AudioHistoryEntry } from './commands/audio-history'
import { timeAgo } from './time-ago'

/** How many tabs the menu lists. */
export const AUDIO_MENU_LIMIT = 10

/** One entry of the resolved audio menu. `command` routes through the registry;
 * `disabled` is the lone "no sound yet" placeholder (never clickable). */
export type AudioMenuItem =
  | { type: 'command'; command: string; params: Record<string, unknown>; label: string }
  | { type: 'disabled'; label: string }

/** A readable name for a tab: its title, else its url, else a generic fallback
 * so an entry is never blank. */
function nameFor(entry: AudioHistoryEntry): string {
  return entry.title.trim() || entry.url.trim() || 'Untitled tab'
}

/** Decide the menu for the audio button from the audio history: the
 * AUDIO_MENU_LIMIT most recent tabs (audible now first), labelled
 * "<title> — playing now | <time ago>", with the profile appended when the list
 * spans several profiles. A single disabled placeholder when nothing has sounded. */
export function buildAudioMenu(entries: AudioHistoryEntry[], now: number): AudioMenuItem[] {
  if (entries.length === 0) {
    return [{ type: 'disabled', label: 'No tab has played sound yet' }]
  }
  const shown = rankAudioHistory(entries).slice(0, AUDIO_MENU_LIMIT)
  const multiProfile = new Set(shown.map((e) => e.profileId)).size > 1
  return shown.map((e) => {
    const when = e.audible ? 'playing now' : timeAgo(e.lastAudibleAt, now)
    const profile = multiProfile ? ` (${e.profileLabel})` : ''
    return {
      type: 'command',
      command: 'activate-tab',
      params: { id: e.tabId },
      label: `${nameFor(e)}${profile} — ${when}`
    }
  })
}
