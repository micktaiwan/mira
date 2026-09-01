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
