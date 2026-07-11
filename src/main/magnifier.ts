// Optical magnifier: a persistent, cursor-anchored visual zoom of the active
// tab, realized by a composited CSS `transform: scale()` on the page's root
// element (injected via the debugger) — NOT `setZoomLevel` (that reflows the
// page; a transform does not, layout is skipped, so the page stays laid out at
// 100%).
//
// Verified live on Electron 41.7 (probes, 2026-07-11/12):
//  - Screen mapping is exactly: surface = page*scale - origin  (origin in
//    surface CSS px) = `translate(-origin) scale(scale)` with origin 0,0.
//  - A CSS transform is pixel-exact at EVERY scale. The obvious alternative,
//    the CDP `Emulation.setDeviceMetricsOverride` viewport clip, was tried first
//    and abandoned: it only maps correctly up to ~2× and mis-places / blanks the
//    view at 3× and above (measured), so it cannot drive a real loupe.
//  - Input is NOT remapped by the transform: a real click at a magnified pixel
//    still hits the un-zoomed page coordinate. So while magnified we run a "look
//    only" mode and SWALLOW clicks (see the input shim); pan is by trackpad
//    scroll. The cursor anchor is read from main (screen cursor), not clientX.
//
// This module is the PURE core (no Electron): the zoom/pan state reducer, the
// transform builder, and the injected input-shim source. The native side
// (applying the transform via the debugger, Cmd detection, the flash) lives in
// the controller; the command domain wires the two.

/** Persistent magnifier state for one view. `scale` is the magnification
 * (1 = off). `originX/originY` are the surface-space offset subtracted after
 * scaling (surface = page*scale - origin), i.e. what the user has panned to. */
export interface MagnifierState {
  scale: number
  originX: number
  originY: number
}

/** No magnification. */
export const NO_MAGNIFIER: MagnifierState = { scale: 1, originX: 0, originY: 0 }

/** Zoom stays within [1, MAX]: 1 = off, 6× is plenty for reading fine print
 * without the render turning to mush. */
export const MAG_MIN_SCALE = 1
export const MAG_MAX_SCALE = 6

/** Wheel-to-zoom sensitivity. Scale is multiplied by exp(-deltaY * K) so zoom
 * feels geometric (each notch a constant ratio) and direction-correct: scrolling
 * up (deltaY < 0) zooms in. One trackpad notch (~120) ≈ a 1.27× step. */
export const MAG_WHEEL_K = 0.002

/** Scale is "on" only clearly above 1, to avoid a stuck 1.0001× clip. */
const ZOOM_EPSILON = 1e-3

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
const clampScale = (s: number): number => clamp(s, MAG_MIN_SCALE, MAG_MAX_SCALE)

/** Is this state actually magnifying (vs. the identity 1× clip)? Below this the
 * controller clears the override entirely and restores normal input. */
export function isMagnified(state: MagnifierState): boolean {
  return state.scale > MAG_MIN_SCALE + ZOOM_EPSILON
}

/** Keep the pan origin inside the un-zoomed viewport so the loupe never shows
 * off-page gutter: at scale s the visible page region is W/s wide, so the origin
 * (surface px) ranges [0, (s-1)*W]. At scale 1 this pins origin to 0. */
function clampOrigin(state: MagnifierState, width: number, height: number): MagnifierState {
  const maxX = Math.max(0, (state.scale - 1) * width)
  const maxY = Math.max(0, (state.scale - 1) * height)
  return {
    scale: state.scale,
    originX: clamp(state.originX, 0, maxX),
    originY: clamp(state.originY, 0, maxY)
  }
}

/** The page point currently under a surface point (the inverse mapping). */
function pageAt(
  state: MagnifierState,
  surfaceX: number,
  surfaceY: number
): { x: number; y: number } {
  return {
    x: (surfaceX + state.originX) / state.scale,
    y: (surfaceY + state.originY) / state.scale
  }
}

/** Adjust the zoom by a wheel delta while keeping the page point under the
 * cursor pinned in place (cursor-anchored zoom). `cursorX/cursorY` are surface
 * CSS px; `width/height` are the view's surface size. Pure. */
export function zoomAt(
  state: MagnifierState,
  cursorX: number,
  cursorY: number,
  deltaY: number,
  width: number,
  height: number
): MagnifierState {
  const nextScale = clampScale(state.scale * Math.exp(-deltaY * MAG_WHEEL_K))
  // The page point under the cursor before the zoom must stay under it after.
  const anchor = pageAt(state, cursorX, cursorY)
  const next: MagnifierState = {
    scale: nextScale,
    originX: anchor.x * nextScale - cursorX,
    originY: anchor.y * nextScale - cursorY
  }
  return clampOrigin(next, width, height)
}

/** Pan by a scroll delta (surface px). Positive dx/dy reveals content further
 * right/down. Clamped to the page. Pure. */
export function panBy(
  state: MagnifierState,
  deltaX: number,
  deltaY: number,
  width: number,
  height: number
): MagnifierState {
  return clampOrigin(
    { scale: state.scale, originX: state.originX + deltaX, originY: state.originY + deltaY },
    width,
    height
  )
}

/** The CSS transform that realizes the magnifier state. Applied to the page's
 * root element (documentElement) with transform-origin 0 0: it renders the whole
 * page scaled by `scale` and panned by `origin` (surface px), so a page point P
 * lands at surface = P*scale - origin — the same mapping the zoom/pan math uses.
 *
 * Why a CSS transform and not the CDP `setDeviceMetricsOverride` viewport clip:
 * verified live that the clip is only reliable up to ~2× and mis-maps above 3×,
 * whereas a composited `transform: scale()` is pixel-exact at every scale and
 * does not reflow the page (transforms skip layout). */
export function magnifierTransform(state: MagnifierState): string {
  return `translate(${-state.originX}px, ${-state.originY}px) scale(${state.scale})`
}

/** JS (run via the debugger) that applies the magnifier transform to the page
 * root, saving the page's own transform/origin/overflow first so we can restore
 * them. Idempotent: it only snapshots the originals once. */
export function applyMagnifierJs(state: MagnifierState): string {
  return (
    `(() => { const e = document.documentElement;` +
    ` if (e.__miraMagPrev === undefined) { e.__miraMagPrev = e.style.transform || '';` +
    ` e.__miraMagPrevOrigin = e.style.transformOrigin || ''; e.__miraMagPrevOverflow = e.style.overflow || ''; }` +
    ` e.style.transformOrigin = '0 0'; e.style.transform = '${magnifierTransform(state)}'; e.style.overflow = 'hidden'; })();`
  )
}

/** JS (run via the debugger) that restores the page root to its pre-magnifier
 * transform/origin/overflow. Safe to run when not magnified (no-op). */
export const CLEAR_MAGNIFIER_JS =
  `(() => { const e = document.documentElement;` +
  ` if (e.__miraMagPrev !== undefined) { e.style.transform = e.__miraMagPrev;` +
  ` e.style.transformOrigin = e.__miraMagPrevOrigin; e.style.overflow = e.__miraMagPrevOverflow;` +
  ` delete e.__miraMagPrev; delete e.__miraMagPrevOrigin; delete e.__miraMagPrevOverflow; } })();`

/** Name of the CDP `Runtime.addBinding` function the injected shim calls to
 * forward input events to main. */
export const MAG_BINDING = '__miraMagnifier'

/** The input shim, injected into every content page via the CDP debugger
 * (`Page.addScriptToEvaluateOnNewDocument`, like the stealth shim). Two
 * independent flags, so we never swallow a click we shouldn't:
 *  - `captureWheel`: preventDefault + forward `wheel` (main turns Cmd+wheel into
 *    zoom, plain wheel into pan). On while Cmd is held OR while magnified.
 *  - `swallowClicks`: preventDefault `click` (magnified clicks land on the wrong
 *    element — verified). On ONLY while magnified, so Cmd+click to open a link in
 *    a background tab keeps working when NOT zoomed.
 * Both default off (the page behaves normally). Forwarding goes through the
 * addBinding function, which emits `Runtime.bindingCalled` to main. Verified
 * live (shim probe, 2026-07-11). */
export const MAGNIFIER_SHIM = `(() => {
  if (window.__miraMag) return;
  const state = { captureWheel: false, swallowClicks: false };
  window.__miraMag = state;
  const send = (o) => { try { window.${MAG_BINDING}(JSON.stringify(o)); } catch (e) {} };
  window.addEventListener('wheel', (e) => {
    if (!state.captureWheel) return;
    e.preventDefault();
    send({ t: 'wheel', dy: e.deltaY, dx: e.deltaX, meta: e.metaKey, x: e.clientX, y: e.clientY });
  }, { capture: true, passive: false });
  window.addEventListener('click', (e) => {
    if (!state.swallowClicks) return;
    e.preventDefault(); e.stopImmediatePropagation();
  }, { capture: true });
})();`

/** JS (run via the debugger) to set the shim's two capture flags in the page. */
export function setShimFlags(captureWheel: boolean, swallowClicks: boolean): string {
  return (
    `window.__miraMag && (window.__miraMag.captureWheel = ${captureWheel ? 'true' : 'false'}, ` +
    `window.__miraMag.swallowClicks = ${swallowClicks ? 'true' : 'false'});`
  )
}

/** JS (run via the debugger) that flashes an animated frame over the page to
 * signal the return to 100% (clicks reliable again). Self-removing, injected
 * into a fixed full-viewport overlay so it never disturbs layout. */
export const MAGNIFIER_FLASH = `(() => {
  const id = '__miraMagFlash';
  document.getElementById(id)?.remove();
  const el = document.createElement('div');
  el.id = id;
  el.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;' +
    'border:4px solid rgba(90,160,255,0.9);box-sizing:border-box;' +
    'animation:__miraMagFlash 320ms ease-out forwards';
  const style = document.createElement('style');
  style.textContent = '@keyframes __miraMagFlash{from{opacity:1}to{opacity:0}}';
  el.appendChild(style);
  document.documentElement.appendChild(el);
  setTimeout(() => el.remove(), 360);
})();`
