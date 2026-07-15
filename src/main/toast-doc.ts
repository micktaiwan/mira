// The toast pill's document: a self-contained HTML page loaded into the
// transparent overlay window (see toast-controller.ts). Colors mirror the dark
// theme tokens in the renderer's base.css (Mira is dark-only). The page carries a
// tiny inline script so main can (re)play the slide+fade animation each time a
// toast fires and read back the pill size to place the window around it.

/** Transparent breathing room around the pill so its shadow and the upward slide
 * are not clipped by the window bounds. Must exceed the shadow's reach (blur 16 +
 * offset 4) and the SLIDE distance below. */
export const PAD = 24

/** How far the pill travels up as it appears (px). Kept within PAD. */
export const SLIDE = 10

/** Total on-screen life of one toast (ms): slide/fade in, hold, then fade out.
 * The controller hides the window after this, so it matches the CSS animation. */
export const TOAST_DURATION_MS = 1800

export const TOAST_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><style>
  html, body { margin: 0; background: transparent; overflow: hidden; }
  body { padding: ${PAD}px; }
  #t {
    display: inline-block;
    max-width: 360px;
    padding: 8px 14px;
    background: #282828;
    color: rgba(255, 255, 245, 0.92);
    border: 1px solid #414853;
    border-radius: 999px;
    font: 12px/1.35 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-weight: 500;
    white-space: nowrap;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
    opacity: 0;
  }
  /* One class toggle plays the whole in-hold-out cycle. Restarted per toast by
     removing/re-adding the class with a reflow in between (see renderScript). */
  #t.show {
    animation: toast ${TOAST_DURATION_MS}ms ease forwards;
  }
  @keyframes toast {
    0%   { opacity: 0; transform: translateY(${SLIDE}px); }
    8%   { opacity: 1; transform: translateY(0); }
    88%  { opacity: 1; transform: translateY(0); }
    100% { opacity: 0; transform: translateY(-4px); }
  }
</style></head>
<body><div id="t"></div></body>
</html>`

export const TOAST_URL = `data:text/html;charset=utf-8,${encodeURIComponent(TOAST_HTML)}`

/** JS (for executeJavaScript) that sets the pill text, (re)starts the animation
 * from the top even if a toast is already showing, and returns the OUTER window
 * size the pill needs: the measured box plus the symmetric PAD on every side.
 * Rounding up avoids a sub-pixel clip that would wrap the text. */
export function renderScript(message: string): string {
  return `(() => {
    const el = document.getElementById('t')
    el.textContent = ${JSON.stringify(message)}
    el.classList.remove('show')
    void el.offsetWidth // force reflow so the animation restarts
    el.classList.add('show')
    const r = el.getBoundingClientRect()
    return { width: Math.ceil(r.width) + ${2 * PAD}, height: Math.ceil(r.height) + ${2 * PAD} }
  })()`
}
