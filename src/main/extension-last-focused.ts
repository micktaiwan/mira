// Which window chrome.windows.getCurrent / getLastFocused answer with.
//
// electron-chrome-extensions remembers the last focused window by id and only
// updates it on a window's 'focus' event. When that window closes — typically
// an extension popout (extension-popout.ts), which takes the focus when it
// opens — the id stays behind, the lookup finds nothing, and getCurrent
// answers null. Bitwarden then fails every popout it positions from the current
// window: "Error building cipher and opening add/edit vault item popout
// TypeError: Cannot read properties of null (reading 'left')", so its inline
// menu's "New item" / "New card" did nothing (measured 2026-11-28 in the pro
// profile, right after a view-item popout closed).
//
// The fix answers with a live window instead: the remembered one when it is
// still open, else the one that has the OS focus, else the first open one.
// Pure; extensions.ts installs it on the lib's store.

/** The slice of a BrowserWindow the choice reads. */
export interface LastFocusedCandidate {
  readonly id: number
  isDestroyed(): boolean
  isFocused(): boolean
}

/** The window getCurrent should answer with, or null when none is open. */
export function resolveLastFocusedWindow<W extends LastFocusedCandidate>(
  lastFocusedId: number | undefined,
  windows: Iterable<W>
): W | null {
  const live = Array.from(windows).filter((w) => !w.isDestroyed())
  if (typeof lastFocusedId === 'number') {
    const remembered = live.find((w) => w.id === lastFocusedId)
    if (remembered) return remembered
  }
  return live.find((w) => w.isFocused()) ?? live[0] ?? null
}
