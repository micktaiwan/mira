// Did the page actually receive the input we just dispatched?
//
// ensurePageVisibleForInput (profiles.ts) decides BEFORE the dispatch whether a
// tab should take input, and its answer is a deduction: "selected tab +
// throttling off = inputtable". Measured 2026-10-02, that deduction was wrong
// for a window fully covered by another app: click, press-key and type all
// answered ok while the page received no event at all and painted no frame
// (requestAnimationFrame never fired in 2.5 s). A scripted login spent four
// clicks on that. The cause is fixed at boot (chromium-switches.ts); this check
// stays, because the next way for input to vanish will not announce itself
// either.
//
// So the dispatch is checked AFTER the fact, on evidence: a one-shot capture
// listener is armed in the page, the input is sent, and the listener is read
// back. No event = the command fails, instead of a success nobody can trust.
//
// The check only speaks when it can know. Input aimed at an iframe is handled
// by another document, and an input that navigates takes the probe away with
// the page: both read as "unknown", and unknown never fails a command.
//
// Pure (script strings + a verdict), so it is unit-testable without Electron;
// the evaluation and the dispatch stay in profiles.ts.

export type InputKind = 'mouse' | 'key'

export type DeliveryVerdict =
  /** The page saw the event. */
  | 'delivered'
  /** The page was watching and saw nothing: the input was dropped. */
  | 'dropped'
  /** Not observable from the top document, or the page went away. */
  | 'unknown'

/** Registry key of the probe. `Symbol.for` so the arm and the read scripts,
 * evaluated separately, reach the same slot without a string global a page
 * could collide with. */
const SLOT = "Symbol.for('mira.input.delivery')"

/** Events that prove a delivery. pointerdown comes first for a click: a disabled
 * control swallows mousedown but still gets pointerdown. */
const EVENTS: Record<InputKind, readonly string[]> = {
  mouse: ['pointerdown', 'mousedown'],
  key: ['keydown']
}

/** How long to keep reading the probe before calling the input dropped. The
 * dispatch resolves once the renderer has acknowledged the event, so this only
 * covers scheduling slack. */
export const DELIVERY_READ_TRIES = 5
export const DELIVERY_READ_INTERVAL_MS = 40

/** Arm the probe. Evaluates to `true` when the top document can observe the
 * input, `false` when it is headed for a frame (the event fires in that
 * frame's document, not here).
 *
 * `point` is where a click is about to land; a key press goes to whatever holds
 * focus. */
export function armDeliveryScript(
  kind: InputKind,
  point?: { x: number; y: number },
  inFrame = false
): string {
  // A click aimed at a named frame (`--frame`) lands in that frame's document,
  // whatever sits under the same point in the top one (a div, a shadow host
  // wrapping the iframe): the top document cannot judge it.
  if (inFrame) return 'false'
  const events = JSON.stringify(EVENTS[kind])
  const target =
    kind === 'mouse' && point
      ? `document.elementFromPoint(${Math.round(point.x)}, ${Math.round(point.y)})`
      : 'document.activeElement'
  return (
    '(() => {' +
    ` const slot = ${SLOT};` +
    ' const state = { seen: false, off: () => {} };' +
    ' const on = () => { state.seen = true };' +
    ` const events = ${events};` +
    ' for (const t of events) window.addEventListener(t, on, true);' +
    ' state.off = () => { for (const t of events) window.removeEventListener(t, on, true) };' +
    ' if (window[slot]) window[slot].off();' +
    ' window[slot] = state;' +
    ` const el = ${target};` +
    // A click needs an element under the point; a key press with nothing
    // focused still reaches the document.
    (kind === 'mouse' ? ' if (!el) return false;' : '') +
    ' return !(el && /^(IFRAME|FRAME|EMBED|OBJECT|WEBVIEW)$/.test(el.tagName))' +
    ' })()'
  )
}

/** Read the probe. Evaluates to `true` / `false`, or `null` when the probe is
 * gone (the input navigated the page away). `final` also removes the listeners
 * and the slot, leaving nothing behind in the page. */
export function readDeliveryScript(final: boolean): string {
  return (
    '(() => {' +
    ` const slot = ${SLOT};` +
    ' const state = window[slot];' +
    ' if (!state) return null;' +
    (final ? ' state.off(); delete window[slot];' : '') +
    ' return state.seen === true' +
    ' })()'
  )
}

/** Turn what the two scripts answered into a verdict. Anything unexpected is
 * "unknown": a check that cannot know must not fail a command that may well
 * have worked. */
export function deliveryVerdict(observable: unknown, seen: unknown): DeliveryVerdict {
  if (observable !== true) return 'unknown'
  if (seen === true) return 'delivered'
  if (seen === false) return 'dropped'
  return 'unknown'
}

/** The error a dropped input raises. Says what was not received and why that
 * usually happens, and what NOT to do about it. */
export function droppedInputMessage(kind: InputKind): string {
  const what = kind === 'mouse' ? 'click' : 'key press'
  return (
    `input was dropped: the page received no ${EVENTS[kind][0]} for this ${what}, nothing happened. ` +
    'Its renderer is not taking input (window fully covered by another app, or minimized). ' +
    'Ask the user to uncover the window; do not raise it yourself.'
  )
}
