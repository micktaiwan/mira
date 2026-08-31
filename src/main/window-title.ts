// What macOS calls a Mira window.
//
// Mira is frameless, so no title bar ever shows a title — which is exactly why
// it was never set. But the OS still names a window by it everywhere the app
// does not draw the chrome itself: Mission Control, the Window menu, and the
// accessibility API a script drives (System Events). Left unset, Chromium pushes
// the chrome page's own <title> onto the window, so every window of every
// profile was called "Electron" and none could be told from another from the
// outside — a script wanting one had to guess a window index by trial and error.
//
// Pure on purpose (the native setTitle call lives in profiles.ts): the format is
// the part worth pinning down in a test.

/** The app name, and the whole title of a window whose profile has no label. */
export const APP_NAME = 'Mira'

/** Title for a window of the profile labelled `label`: `Mira — <label>`.
 * A blank / whitespace-only label degrades to the bare app name rather than
 * leaving a dangling separator. */
export function windowTitle(label: string | null | undefined): string {
  const trimmed = (label ?? '').trim()
  return trimmed === '' ? APP_NAME : `${APP_NAME} — ${trimmed}`
}
