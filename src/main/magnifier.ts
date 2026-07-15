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

/** Zoom floors at 1× (off) and has NO upper cap — you can push it as far as you
 * want (the render turns to mush eventually, but that's the user's call). */
export const MAG_MIN_SCALE = 1

/** Wheel-to-zoom sensitivity. Scale is multiplied by exp(-deltaY * K) so zoom
 * feels geometric (each notch a constant ratio) and direction-correct: scrolling
 * up (deltaY < 0) zooms in. One trackpad notch (~120) ≈ a 1.27× step. */
export const MAG_WHEEL_K = 0.002

/** Clean-exit threshold: when zooming OUT lands the scale below this, snap to a
 * hard 1× (off) instead of leaving a near-1 residual. Without it, trackpad
 * momentum drops you on an invisible ~1.01× that still reads as magnified, so the
 * wheel stays captured and the page cannot scroll natively — the "zoom eats the
 * scroll" bug, only cleared by a reload. Directional (only on the way out) so a
 * gentle zoom-IN from 1× is never swallowed. */
export const MAG_SNAP_OUT = 1.05

/** Scale is "on" only clearly above 1, to avoid a stuck 1.0001× clip. */
const ZOOM_EPSILON = 1e-3

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
const clampScale = (s: number): number => Math.max(MAG_MIN_SCALE, s)

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
  let nextScale = clampScale(state.scale * Math.exp(-deltaY * MAG_WHEEL_K))
  // Clean exit: zooming out (deltaY > 0) into the near-1 band collapses to a hard
  // 1×, so we never sit on an invisible residual that keeps the wheel captured.
  if (deltaY > 0 && nextScale < MAG_SNAP_OUT) nextScale = MAG_MIN_SCALE
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
 * them. Idempotent: it only snapshots the originals once.
 *
 * Scroll compensation: the transform-origin (0,0) is the document's top-left,
 * not the viewport's. On a scrolled page those differ by the scroll offset, so a
 * plain `translate(-origin) scale` would anchor the zoom off-screen. We fold the
 * live scroll in: `t = -origin - scroll*(scale-1)`, which re-anchors the whole
 * transform to the VIEWPORT top-left regardless of how far the page is scrolled.
 * Scroll is read at apply time (and frozen by `overflow:hidden`, plus the wheel
 * shim blocks native scroll while magnified, so it stays put). */
export function applyMagnifierJs(state: MagnifierState): string {
  const { scale, originX, originY } = state
  return (
    `(() => { const e = document.documentElement;` +
    ` if (e.__miraMagPrev === undefined) { e.__miraMagPrev = e.style.transform || '';` +
    ` e.__miraMagPrevOrigin = e.style.transformOrigin || ''; e.__miraMagPrevOverflow = e.style.overflow || ''; }` +
    ` const k = ${scale}, sx = window.scrollX || 0, sy = window.scrollY || 0;` +
    ` const tx = ${-originX} - sx * (k - 1), ty = ${-originY} - sy * (k - 1);` +
    ` e.style.transformOrigin = '0 0';` +
    ` e.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(' + k + ')';` +
    ` e.style.overflow = 'hidden'; })();`
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
 * independent flags, both on ONLY while magnified, so we never swallow input we
 * shouldn't:
 *  - `captureWheel`: preventDefault + forward `wheel` (main turns Cmd+wheel into
 *    zoom, plain wheel into pan). Needed so pan keeps working after Cmd is
 *    released while zoomed.
 *  - `swallowClicks`: preventDefault `click` (magnified clicks land on the wrong
 *    element — verified). Off when not zoomed, so Cmd+click to open a link in a
 *    background tab keeps working.
 * Both default off (the page behaves normally). Forwarding goes through the
 * addBinding function, which emits `Runtime.bindingCalled` to main. Verified
 * live (shim probe, 2026-07-11).
 *
 * Cmd+wheel is captured on `e.metaKey` directly, read off the wheel event
 * itself — never via a "Cmd is held" flag pushed from main. Both alternatives
 * were tried and lost a race each:
 *  - flag armed on Cmd keyDown (before-input-event): async and focus-dependent,
 *    the FIRST Cmd+scroll from 100% leaked to the native page scroll before the
 *    flag arrived (the "Chromium steals the scroll while Cmd is held" bug);
 *  - the same flag going stale the OTHER way: its keyUp could land on the
 *    chrome, another tab or another app, leaving it stuck true — re-pushed into
 *    every freshly loaded page, whose shim then swallowed ALL plain wheel
 *    events (the "page refuses to scroll after load" bug).
 * There is no legit plain Cmd+wheel on a page besides zoom, so keying capture
 * on `e.metaKey` alone is always correct.
 *
 * Scroll-chain freeze: preventDefault alone CANNOT stop a wheel whose gesture is
 * already latched to a scroller (Cmd pressed mid-gesture, or during momentum) —
 * Chromium keeps scrolling on the compositor and delivers those events with
 * cancelable=false. The page ROOT is already covered: applyMagnifierJs puts
 * overflow:hidden on documentElement at the first zoom apply, which kills the
 * latched gesture there. But an INNER scrollable element (split layouts, chat
 * panes…) kept scrolling under a Cmd+wheel zoom, shifting the content under the
 * cursor so the zoom looked mis-anchored. So every captured wheel also freezes
 * the target's scrollable ancestor chain the same way (overflow:hidden unlatches
 * the gesture), then restores style + scroll offsets once the burst goes idle. */
export const MAGNIFIER_SHIM = `(() => {
  if (window.__miraMag) return;
  const state = { captureWheel: false, swallowClicks: false };
  window.__miraMag = state;
  const send = (o) => { try { window.${MAG_BINDING}(JSON.stringify(o)); } catch (e) {} };
  const frozen = [];
  let idleTimer = 0;
  const unfreeze = () => {
    for (const f of frozen) {
      f.el.style.overflowX = f.ox; f.el.style.overflowY = f.oy;
      f.el.scrollLeft = f.x; f.el.scrollTop = f.y;
    }
    frozen.length = 0;
  };
  const scrolls = (ov, extra) => (ov === 'auto' || ov === 'scroll') && extra > 0;
  const freeze = (start) => {
    if (!frozen.length) {
      // Walk up from the wheel target (escaping shadow roots via the host),
      // stopping at the root/body: those belong to the magnifier's own freeze.
      for (let el = start; el && el !== document.documentElement && el !== document.body;
           el = el.parentElement || el.getRootNode()?.host) {
        if (!(el instanceof Element)) break;
        const s = getComputedStyle(el);
        if (scrolls(s.overflowY, el.scrollHeight - el.clientHeight) ||
            scrolls(s.overflowX, el.scrollWidth - el.clientWidth)) {
          frozen.push({ el, ox: el.style.overflowX, oy: el.style.overflowY,
            x: el.scrollLeft, y: el.scrollTop });
          el.style.overflow = 'hidden';
        }
      }
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(unfreeze, 250);
  };
  window.addEventListener('wheel', (e) => {
    if (!state.captureWheel && !e.metaKey) return;
    e.preventDefault();
    freeze(e.target);
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

/** JS (run via the debugger) that shows or hides a PERSISTENT red frame around
 * the viewport while the magnifier is on, so the user always knows the page is
 * zoomed (and hence why the wheel pans instead of scrolling) — the flash alone
 * was only an exit blip and too easy to miss.
 *
 * It must be a top-layer element (`popover`), NOT a plain fixed div: the page
 * root carries the magnifier's `transform: scale()`, which makes it the
 * containing block for `position:fixed` descendants, so a fixed frame gets
 * scaled and offset with the page (verified live: a fixed inset:0 child rendered
 * at 2× size, off-screen). A popover renders in the browser top layer, anchored
 * to the viewport regardless of ancestor transforms (verified live: inset:0
 * popover measured exactly the viewport width under a 2× transform). Idempotent;
 * `pointer-events:none` so it never eats input. */
export function magnifierFrameJs(on: boolean): string {
  const id = '__miraMagFrame'
  if (!on) {
    return (
      `(() => { const el = document.getElementById('${id}');` +
      ` if (el) { try { el.hidePopover(); } catch (e) {} el.remove(); } })();`
    )
  }
  return (
    `(() => { let el = document.getElementById('${id}');` +
    ` if (!el) { el = document.createElement('div'); el.id = '${id}';` +
    ` el.setAttribute('popover', 'manual');` +
    ` el.style.cssText = 'margin:0;padding:0;inset:0;width:auto;height:auto;' +` +
    ` 'background:transparent;border:3px solid rgba(255,60,60,0.9);box-sizing:border-box;' +` +
    ` 'pointer-events:none;';` +
    ` document.documentElement.appendChild(el); }` +
    ` if (!el.matches(':popover-open')) { try { el.showPopover(); } catch (e) {} } })();`
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
