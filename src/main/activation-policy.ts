// Pure policy for the background-reload activation guard.
//
// The native swizzle (native/mira-activation, loaded via mac-activation.ts) and
// the Electron window plumbing are the untested native edge; this decision — WHEN
// to arm suppression — is pulled out here so it is unit-tested, per Mira's "tout
// testable" principle.

export interface NavKind {
  /** True when the navigation is in the top-level frame (not a sub-frame/iframe). */
  isMainFrame: boolean
  /** True for a same-document navigation (hash change, history.pushState) — these
   * do not re-commit a document and carry no focus-steal. */
  isSameDocument: boolean
}

/** Whether a navigation should arm suppression of programmatic app activation.
 *
 * Only a cross-document MAIN-frame navigation carries Chromium's post-commit
 * focus-steal, and only a BACKGROUND window (not focused) can be intruded on — a
 * foreground navigation the user drove must activate the page as usual. */
export function shouldSuppressActivation(nav: NavKind, windowFocused: boolean): boolean {
  return nav.isMainFrame && !nav.isSameDocument && !windowFocused
}
