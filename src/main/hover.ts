// Report what the cursor rests on inside a web page, for the status bar.
//
// Chromium's native `update-target-url` event covers hovering a LINK (an anchor
// with an href): it hands us the target URL. But it stays silent for controls
// that fire JavaScript instead of navigating — a `<button>`, `[role="button"]`,
// an `onclick` handler, an `<a href="javascript:…">`. Hover one of those and the
// status bar would show nothing. This module fills that gap.
//
// Detection has to happen INSIDE the page (only the page knows what element is
// under the cursor), and the page needs a channel back to main. Same constraint
// as the stealth shim (stealth.ts): the reliable primitive is CDP via
// `webContents.debugger`. We inject a document-start script that watches hover,
// and register a `Runtime.addBinding` function the page can call to report back.
//
// Two sources, one status field, merged by `reduceHover`: a real link wins (show
// its URL); otherwise a JS control shows "Action JS"; otherwise nothing. Keeping
// the merge a pure function is the "tout testable" split — the CDP plumbing below
// is the thin native bit, `reduceHover`/`hoverText` hold the logic and are tested.

import type { WebContents } from 'electron'

/** The label shown for a JS-triggering control (a button that runs script rather
 * than navigating). English, per the product language rule. */
export const JS_ACTION_LABEL = 'Action JS'

/** Name of the CDP binding the injected page script calls to report a hover. */
const BINDING = '__miraHoverReport'

/** What the cursor is resting on in the page, merged from both hover sources. */
export interface HoverState {
  /** A navigable link's URL, or '' when the cursor is not over a real link. */
  targetUrl: string
  /** True while the cursor is over a control that triggers JS (no navigation). */
  jsAction: boolean
}

export const EMPTY_HOVER: HoverState = { targetUrl: '', jsAction: false }

/** An update from one of the two hover sources.
 *  - `target`: Chromium's `update-target-url` (the link under the cursor, or '').
 *  - `js`: our injected detector toggling whether a JS control is under the cursor. */
export type HoverEvent = { type: 'target'; url: string } | { type: 'js'; active: boolean }

/** Fold a hover source event into the merged state.
 *
 * A `javascript:` URL from `update-target-url` is NOT a navigable link — it's a
 * JS control, and our injected detector already flags it (such anchors match the
 * detector's selector). So we drop it here and let the `js` event own that state;
 * that keeps a single source for the JS case and avoids the two sources fighting
 * to set and clear the same flag. */
export function reduceHover(prev: HoverState, event: HoverEvent): HoverState {
  if (event.type === 'target') {
    const navigable = event.url && !event.url.startsWith('javascript:')
    return { ...prev, targetUrl: navigable ? event.url : '' }
  }
  return { ...prev, jsAction: event.active }
}

/** The single string to show in the status bar for a hover state: a real link's
 * URL wins over the generic JS label; nothing when the cursor rests on neither. */
export function hoverText(state: HoverState): string {
  if (state.targetUrl) return state.targetUrl
  return state.jsAction ? JS_ACTION_LABEL : ''
}

/** Page-world detector, injected at document-start in every frame. It reports
 * only the JS-control case (links are handled natively by update-target-url), and
 * only on transitions (it dedups), so main gets a clean on/off signal.
 *
 * The selector is the set of "this click runs JS, it doesn't navigate": buttons,
 * ARIA buttons, inline onclick handlers, and `javascript:` anchors. `closest`
 * walks up so hovering an icon inside a button still counts. */
const DETECTOR_SOURCE = String.raw`
(() => {
  if (window.__miraHoverWired) return;
  window.__miraHoverWired = true;
  var SEL = 'button, [role="button"], [onclick], input[type="button"], input[type="submit"], input[type="reset"], a[href^="javascript:"]';
  var last = null;
  var report = function (active) {
    if (active === last) return;
    last = active;
    try { window.${BINDING}(active ? '1' : '0'); } catch (e) {}
  };
  var hitFrom = function (t) {
    return !!(t && t.closest && t.closest(SEL));
  };
  document.addEventListener('mouseover', function (e) { report(hitFrom(e.target)); }, true);
  document.addEventListener('mousemove', function (e) { report(hitFrom(e.target)); }, true);
  // Cursor leaving the document (relatedTarget null) clears the flag.
  document.addEventListener('mouseout', function (e) { if (!e.relatedTarget) report(false); }, true);
})();
`

/** Wire JS-control hover reporting onto one tab's web page. Best-effort and
 * never throws — like the stealth shim, hover reporting must not break a page.
 *
 * `onJsHover(active)` fires whenever the cursor enters/leaves a JS control. The
 * debugger may already be attached (stealth attaches it on web-contents-created);
 * we guard the attach and just add our binding + script and a message listener,
 * which coexist with stealth's on the same session. */
export function installHoverReporter(wc: WebContents, onJsHover: (active: boolean) => void): void {
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
    // Runtime.enable must precede addBinding; Page.enable precedes addScript.
    wc.debugger
      .sendCommand('Runtime.enable')
      .then(() => wc.debugger.sendCommand('Runtime.addBinding', { name: BINDING }))
      .catch((error) => console.error('[mira] hover: addBinding failed', error))
    wc.debugger
      .sendCommand('Page.enable')
      .then(() =>
        wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
          source: DETECTOR_SOURCE
        })
      )
      .catch((error) => console.error('[mira] hover: addScript failed', error))
  } catch (error) {
    console.error('[mira] hover: debugger attach failed', error)
  }
  wc.debugger.on('message', (_event, method, params) => {
    if (method !== 'Runtime.bindingCalled') return
    const p = params as { name?: string; payload?: string }
    if (p.name === BINDING) onJsHover(p.payload === '1')
  })
}
