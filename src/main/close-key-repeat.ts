// Holding Cmd+W must close ONE tab, not every tab the key repeat reaches.
//
// macOS auto-repeats a held key, and an Electron menu accelerator fires on every
// repeat: a long press on Cmd+W once closed a whole run of tabs. The menu click
// handler gets no "is a repeat" bit, but `before-input-event` does
// (`input.isAutoRepeat`), and preventing it there also stops the menu shortcut.
// So the repeat is dropped in the input hook every webContents carries
// (wireTabShortcuts), and the moment is remembered: a repeat that lands while no
// webContents holds focus (the closed tab's view just went away) reaches the
// menu directly, and the menu handler then skips it because a blocked repeat was
// seen a moment ago. Pure, no Electron.

/** The slice of Electron's before-input-event Input this module reads. */
export interface CloseKeyInput {
  type: string
  key: string
  isAutoRepeat: boolean
  meta: boolean
  control: boolean
}

/** True for an auto-repeated keyDown of a Cmd(+any)+W shortcut: Close Tab,
 * Close Tab to Recent, Close Window, Forget Site. None of them should repeat.
 * Matched on the character, not the physical key, like the menu accelerator
 * (on AZERTY the "w" character sits on the QWERTY Z key; Cmd+Z must keep
 * repeating for undo). */
export function isRepeatedCloseKey(input: CloseKeyInput, platform: string): boolean {
  if (input.type !== 'keyDown' || !input.isAutoRepeat) return false
  const mod = platform === 'darwin' ? input.meta : input.control
  return mod && input.key.toLowerCase() === 'w'
}

/** How long after a blocked repeat a menu-triggered close is still taken for
 * part of the same held key. The macOS repeat interval is 15–120 ms depending on
 * the Key Repeat setting; a deliberate second Cmd+W needs a release and a new
 * press, and the first repeat of a fresh press only comes after the initial
 * delay (≥ 225 ms), so the window stays clear of intentional presses. */
export const CLOSE_REPEAT_GUARD_MS = 200

/** Remembers the last blocked repeat and says whether a menu close at `now`
 * belongs to that held key. */
export class CloseKeyRepeatGuard {
  private lastRepeatAt = -Infinity

  noteRepeat(now: number): void {
    this.lastRepeatAt = now
  }

  /** True when the menu close should be ignored. */
  isHeld(now: number): boolean {
    return now - this.lastRepeatAt < CLOSE_REPEAT_GUARD_MS
  }
}

/** One guard for the whole app: the key is held on the keyboard, not in a window. */
export const closeKeyRepeatGuard = new CloseKeyRepeatGuard()
