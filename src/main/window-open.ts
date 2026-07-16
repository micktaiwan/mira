// Pure decision for what to do when a page calls window.open (or a link targets a
// new window). Kept separate from the native setWindowOpenHandler so it is
// unit-testable without Electron (see the "tout testable" principle in CLAUDE.md).
//
// The distinction that matters is popup vs tab:
//   - A POPUP (window.open with window features → Chromium NEW_POPUP, surfaced by
//     Electron as disposition 'new-window'/'new-popup') must become a REAL child
//     window. OAuth / SSO sign-in (Google, Microsoft…) opens such a popup and then
//     posts the auth result back to `window.opener` / closes itself for the opener
//     to read. Detaching it into a standalone tab breaks that opener relationship,
//     so the sign-in never completes (the classic "the account chooser opens but I
//     stay logged out" bug).
//   - Everything else (target=_blank links, background-tab from Cmd+click) is a
//     plain new page → open it as a Mira tab, as usual.

/** The subset of Electron's window-open details this decision needs. */
export interface WindowOpenDetails {
  url: string
  /** Electron's disposition. 'new-window'/'new-popup' == a Chromium popup. */
  disposition?: string
  /** The opener page's referrer, as Electron reports it. Carried onto the new
   * tab's load so it behaves like Chrome's target=_blank — see below. */
  referrer?: { url: string }
}

export type WindowOpenDecision =
  | { kind: 'popup' }
  /** referrer: the opener's URL to send as the tab load's Referer header. Chrome
   * sets it on a target=_blank open; some outbound gateways need it (LinkedIn's
   * www.linkedin.com/safety/go?url=… 404s to its language page without a
   * linkedin.com Referer — verified 2026-07-16). Undefined when the opener had
   * an empty referrer (e.g. a rel=noreferrer link). */
  | { kind: 'tab'; url: string; referrer?: string }

/** Decide how to handle a window.open: as a real popup window (opener preserved,
 * needed for OAuth/SSO) or as a Mira tab. */
export function decideWindowOpen(details: WindowOpenDetails): WindowOpenDecision {
  if (details.disposition === 'new-window' || details.disposition === 'new-popup') {
    return { kind: 'popup' }
  }
  const referrer = details.referrer?.url || undefined
  return { kind: 'tab', url: details.url, referrer }
}
