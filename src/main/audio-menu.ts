// The drop-down shown by the toolbar's audio button: the list of tabs currently
// playing sound, click one to jump to it. Like tab-menu.ts, the popup itself is
// thin and NATIVE (in profiles.ts) — a CSS popover over the toolbar would be
// clipped by the WebContentsView (main-native-gotchas.md #3), and a native menu
// always composites above it. This pure, testable function decides WHICH items
// to show for a given set of audible tabs.
//
// Each entry is a `select-tab` command carrying its tab id, so clicking it routes
// through the same registry bus as everything else ("tout pilotable") and focuses
// that tab. When nothing is audible the menu shows a single disabled placeholder.

/** One audible tab as the menu needs it: its id (the select target) and a label
 * to show (its title, falling back to its url). */
export interface AudioMenuTab {
  id: string
  title: string
  url: string
}

/** One entry of the resolved audio menu. `command` routes through the registry;
 * `disabled` is the lone "nothing is playing" placeholder (never clickable). */
export type AudioMenuItem =
  | { type: 'command'; command: string; params: Record<string, unknown>; label: string }
  | { type: 'disabled'; label: string }

/** A readable label for a tab in the menu: its title, else its url, else a
 * generic fallback so an entry is never blank. */
function labelFor(tab: AudioMenuTab): string {
  return tab.title.trim() || tab.url.trim() || 'Untitled tab'
}

/** Decide the menu for the audio button: one `select-tab` item per audible tab
 * (in the order given), or a single disabled placeholder when none is playing. */
export function buildAudioMenu(tabs: AudioMenuTab[]): AudioMenuItem[] {
  if (tabs.length === 0) {
    return [{ type: 'disabled', label: 'No tabs playing audio' }]
  }
  return tabs.map((tab) => ({
    type: 'command',
    command: 'select-tab',
    params: { id: tab.id },
    label: labelFor(tab)
  }))
}
