// Keep a key injected through CDP away from the native menu. The dispatch
// itself stays in profiles.ts; this is the state wrapper around it.

/** Run `dispatch` with the application menu's shortcuts ignored for `wc`'s
 * webContents, then restore the flag.
 *
 * Why: `Input.dispatchKeyEvent` has to carry a native key code for a page to see
 * the right `code` (see MAC_VIRTUAL_KEYS in input-keys.ts). Chromium only sets
 * `skip_if_unhandled` — the thing that STOPS handing an unconsumed key back to
 * the native menu — when that code is absent
 * (content/browser/devtools/protocol/input_handler.cc). With it, a Cmd+<key>
 * the page ignores reaches the menu, where the rebuilt NSEvent carries empty
 * `characters` and `charactersIgnoringModifiers` under Cmd
 * (native_input_event_builder_mac.mm), and AppKit matches the first item with
 * no key equivalent: `{ role: 'about' }` (menu.ts).
 *
 * Measured 2026-10-27 on Electron 44.4.1 with the exact payload
 * `keyToDispatchEvents` builds: a CDP Cmd+Y aimed at a webContents that was NOT
 * the focused one still fired that first item, and `setIgnoreMenuShortcuts(true)`
 * stopped it while the page kept receiving the keydown. So this does not
 * intercept the menu, it stops the key from reaching it — and it holds for the
 * underlay case, not just a focused tab.
 *
 * Restored in a `finally`: a throw from the dispatch (the dropped-input guard)
 * must not leave the flag on, or every later real Cmd+<key> in that tab would be
 * silently dead. */
export async function withMenuShortcutsIgnored(
  wc: { setIgnoreMenuShortcuts(ignore: boolean): void },
  dispatch: () => Promise<void>
): Promise<void> {
  wc.setIgnoreMenuShortcuts(true)
  try {
    await dispatch()
  } finally {
    wc.setIgnoreMenuShortcuts(false)
  }
}
