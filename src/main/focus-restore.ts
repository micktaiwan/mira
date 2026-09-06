/** Which surface of a Mira window last held the keyboard: the chrome (address
 * bar, palette, settings panel) or the active tab's page.
 *
 * Electron does NOT restore this across an app switch: coming back to Mira from
 * another app leaves the keyboard on the window's own webContents — the chrome —
 * whatever the user was typing in before they left. So the window remembers its
 * own last focus target (fed by the per-webContents 'focus' events) and re-applies
 * it when the window is focused again. */
export type FocusTarget = 'chrome' | 'page'

/** Should re-focusing the window hand the keyboard back to the page?
 *
 * Only when the page is what the user left focused AND the active tab actually
 * has a web view (the Settings tab is chrome-rendered and has none). A chrome
 * target is left alone: a focused address bar must survive the app switch. */
export function shouldRestorePageFocus(input: {
  target: FocusTarget
  hasActivePage: boolean
}): boolean {
  return input.target === 'page' && input.hasActivePage
}

/** Should selecting a tab hand the keyboard to the newly active page?
 *
 * Switching tabs used to leave the keyboard wherever it was — usually the chrome —
 * so the first keystroke after a tab switch went to the window instead of the
 * site. Focusing the page fixes that, but only under four conditions:
 *
 * - `userDriven`: the select came from Mira's own UI (click, Cmd+Up/Down, MRU),
 *   never from a script, an extension hook or the background-open restore, which
 *   would rip focus out of whatever the user is typing in.
 * - `windowFocused`: focusing a webContents in a background window is exactly the
 *   foreground theft foreground-policy.ts forbids.
 * - `hasActivePage`: the Settings tab is chrome-rendered and has no web view.
 * - `!overlayOpen`: while the palette or the media gallery is up, layout() hides
 *   every view — the chrome owns the keyboard on purpose. */
export function shouldFocusPageOnTabSelect(input: {
  userDriven: boolean
  windowFocused: boolean
  hasActivePage: boolean
  overlayOpen: boolean
}): boolean {
  return input.userDriven && input.windowFocused && input.hasActivePage && !input.overlayOpen
}
