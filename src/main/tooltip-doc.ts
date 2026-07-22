// The tooltip bubble's document: a self-contained HTML page loaded into the
// transparent overlay window (see profiles.ts). Colors mirror the dark theme
// tokens in the renderer's base.css (Mira is dark-only). No <script> — the page
// is inert; main sets its text and measures it via executeJavaScript
// (measureScript), then sizes/places the window around it (see profiles.ts).

/** Transparent breathing room around the bubble so its CSS shadow is not clipped
 * by the window bounds. Must exceed the shadow's downward reach (blur 12 + offset
 * 3 = 15). The bubble is centered in this padding, so centering the window over
 * the anchor centers it. */
export const PAD = 16

export const TOOLTIP_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><style>
  html, body { margin: 0; background: transparent; }
  body { padding: ${PAD}px; }
  #b {
    display: inline-block;
    max-width: 360px;
    padding: 6px 10px;
    background: #282828;
    color: rgba(255, 255, 245, 0.86);
    border: 1px solid #414853;
    border-radius: 6px;
    font: 11px/1.35 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-variant-numeric: tabular-nums;
    /* pre-line keeps \\n breaks (tab tooltips are "title\\nurl") while still
       wrapping lines longer than max-width (long urls). */
    white-space: pre-line;
    overflow-wrap: break-word;
    box-shadow: 0 3px 12px rgba(0, 0, 0, 0.45);
  }
</style></head>
<body><div id="b"></div></body>
</html>`

export const TOOLTIP_URL = `data:text/html;charset=utf-8,${encodeURIComponent(TOOLTIP_HTML)}`

/** JS (for executeJavaScript) that sets the bubble text and returns the OUTER
 * window size the bubble needs: the measured box plus the symmetric PAD on every
 * side. Rounding up avoids a sub-pixel clip that would wrap the text. */
export function measureScript(text: string): string {
  return `(() => {
    const el = document.getElementById('b')
    el.textContent = ${JSON.stringify(text)}
    // The overlay window is pre-warmed at ~10px wide, so the body's containing
    // block is far narrower than the bubble's max-width. Without a roomy layout
    // context the inline-block shrink-to-fit collapses to the widest single word
    // and the text wraps one word per line. Force a wide body during measurement
    // so the bubble reaches its natural width (up to max-width) before we read it.
    document.body.style.width = '9999px'
    const r = el.getBoundingClientRect()
    document.body.style.width = ''
    return { width: Math.ceil(r.width) + ${2 * PAD}, height: Math.ceil(r.height) + ${2 * PAD} }
  })()`
}
