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
//
// The second distinction is foreground vs background, and it rides on the same
// disposition. Chromium already encodes the standard browser convention there:
// a plain target=_blank or a Cmd+Shift+click is 'foreground-tab' (jump to the new
// tab), a Cmd+click is 'background-tab' (the tab loads behind, we stay on the
// page we were reading). Modifiers themselves never reach this handler, so the
// disposition is the only signal — which is why the convention has to be the
// standard one: nothing here can tell a Cmd+Shift+click from a target=_blank.

/** The subset of Electron's window-open details this decision needs. */
export interface WindowOpenDetails {
  url: string
  /** Electron's disposition. 'new-window'/'new-popup' == a Chromium popup. */
  disposition?: string
  /** The opener page's referrer, as Electron reports it. Carried onto the new
   * tab's load so it behaves like Chrome's target=_blank — see below. */
  referrer?: { url: string }
  /** Set by Electron ONLY when the new window comes from a FORM that posts to
   * target=_blank. Its body has to be replayed on the tab's load, or the page
   * that opens is a plain GET of the form action — see postLoad below. */
  postBody?: { data: unknown[]; contentType?: string; boundary?: string }
}

/** What a tab has to replay to reproduce a form POST: the raw body parts, in
 * Electron's loadURL(postData) shape, plus the Content-Type the form used. */
export interface PostLoad {
  postData: unknown[]
  extraHeaders: string
}

export type WindowOpenDecision =
  | { kind: 'popup' }
  /** referrer: the opener's URL to send as the tab load's Referer header. Chrome
   * sets it on a target=_blank open; some outbound gateways need it (LinkedIn's
   * www.linkedin.com/safety/go?url=… 404s to its language page without a
   * linkedin.com Referer — verified 2026-07-16). Undefined when the opener had
   * an empty referrer (e.g. a rel=noreferrer link).
   * background: true for a Cmd+click ('background-tab') — the new tab is added
   * without becoming active, so the user stays on the page they were reading.
   * post: set when the opener was a form posting to target=_blank; the tab must
   * load with this body instead of a bare GET (see postLoad). */
  | { kind: 'tab'; url: string; referrer?: string; background: boolean; post?: PostLoad }

/** Decide how to handle a window.open: as a real popup window (opener preserved,
 * needed for OAuth/SSO) or as a Mira tab. */
export function decideWindowOpen(details: WindowOpenDetails): WindowOpenDecision {
  if (details.disposition === 'new-window' || details.disposition === 'new-popup') {
    return { kind: 'popup' }
  }
  const referrer = details.referrer?.url || undefined
  const background = details.disposition === 'background-tab'
  return { kind: 'tab', url: details.url, referrer, background, post: postLoad(details) }
}

/** Turn Electron's postBody into what loadURL needs, or undefined when the open
 * carries no form body (the ordinary target=_blank link).
 *
 * WHY this exists: a form that posts to target=_blank is the only window.open
 * whose URL alone does not reproduce the page. Re-fetching the action with a GET
 * gets a different response — for a PrimeFaces "download this attachment" button
 * (impots.gouv.fr's messagerie, verified 2026-09-09) the POST returns the PDF
 * with Content-Disposition: attachment, while the GET just re-renders the portal
 * and nothing downloads. So the body travels with the decision and the tab
 * replays it.
 *
 * The Content-Type must be rebuilt by hand: Chromium reports the form's encoding
 * in `contentType` and, for multipart bodies, the separator in `boundary` — and a
 * multipart body is unparseable server-side without its boundary. */
export function postLoad(details: WindowOpenDetails): PostLoad | undefined {
  const body = details.postBody
  if (!body || !Array.isArray(body.data) || body.data.length === 0) return undefined
  const contentType = body.contentType || 'application/x-www-form-urlencoded'
  const full = body.boundary ? `${contentType}; boundary=${body.boundary}` : contentType
  return { postData: body.data, extraHeaders: `Content-Type: ${full}` }
}

/** Same decision, but for a window.open coming from an EXTENSION page (a
 * browser-action popup, an option page…). The extra 'ignore' outcome means "not
 * an extension page, leave Electron's default alone" — the caller sets a global
 * window-open handler on every webContents, so it must recognize the ones it has
 * no business touching. Pure so it is unit-testable without Electron. */
export type ExtensionWindowOpenDecision = { kind: 'ignore' } | WindowOpenDecision

export function decideExtensionWindowOpen(
  openerUrl: string,
  details: WindowOpenDetails
): ExtensionWindowOpenDecision {
  if (!openerUrl.startsWith('chrome-extension://')) return { kind: 'ignore' }
  return decideWindowOpen(details)
}
