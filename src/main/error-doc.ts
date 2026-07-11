// The Mira error page: what a tab shows when a load fails (DNS failure, refused
// connection, timeout…) instead of Chromium's blank void. Like home-doc.ts, it is
// a self-contained HTML document loaded into the tab's WebContentsView as a
// data: URL. It shows a human-readable explanation of the failure, the URL that
// failed, the raw Chromium error name, and a Retry button that re-navigates to
// the original URL.
//
// buildErrorPage / errorPageUrl are pure and tested; profiles.ts listens to
// did-fail-load and calls in (see wireView).

/** What profiles.ts knows about a failed load, straight from did-fail-load. */
export interface LoadError {
  /** The URL whose load failed (did-fail-load's validatedURL). */
  url: string
  /** Chromium net error code, e.g. -105. */
  errorCode: number
  /** Chromium error name, e.g. "ERR_NAME_NOT_RESOLVED". */
  errorDescription: string
}

/** A marker embedded in the page as an HTML comment. Its letters survive URL
 * encoding unchanged, so main can recognize "this navigation is our error page"
 * from the data: URL alone (isMiraErrorUrl) and keep the address bar showing the
 * failed URL instead of the data: URL — see wireView's mirrorUrl. */
const ERROR_MARKER = 'mira-error-page'

/** True when `url` is the Mira error page. */
export function isMiraErrorUrl(url: string): boolean {
  return url.includes(ERROR_MARKER)
}

/** Human-readable headline + hint for the common Chromium net error codes.
 * Anything unmapped falls back to a generic "page failed to load". */
export function describeLoadError(err: LoadError): { headline: string; hint: string } {
  switch (err.errorCode) {
    case -105: // ERR_NAME_NOT_RESOLVED
      return {
        headline: "This site can't be reached",
        hint: `The server address could not be found. Check the URL for typos — the domain may not exist.`
      }
    case -106: // ERR_INTERNET_DISCONNECTED
      return {
        headline: 'No internet connection',
        hint: 'Your computer appears to be offline. Check your network and try again.'
      }
    case -102: // ERR_CONNECTION_REFUSED
      return {
        headline: 'Connection refused',
        hint: 'The server is reachable but refused the connection. It may be down or not listening on this port.'
      }
    case -101: // ERR_CONNECTION_RESET
      return {
        headline: 'Connection reset',
        hint: 'The connection was interrupted by the server or something in between. Retrying often works.'
      }
    case -7: // ERR_TIMED_OUT
    case -118: // ERR_CONNECTION_TIMED_OUT
      return {
        headline: 'Connection timed out',
        hint: 'The server took too long to respond. It may be overloaded, or blocked by a firewall.'
      }
    case -109: // ERR_ADDRESS_UNREACHABLE
      return {
        headline: 'Address unreachable',
        hint: 'No route to the server. Check your network, VPN, or proxy configuration.'
      }
    default:
      if (err.errorCode <= -200 && err.errorCode > -300) {
        return {
          headline: 'Connection is not secure',
          hint: 'The site presented an invalid security certificate, so Mira did not load it.'
        }
      }
      return {
        headline: 'This page failed to load',
        hint: 'Something went wrong while loading the page. Retrying may fix it.'
      }
  }
}

/** Escape a value for safe interpolation into HTML text/attributes. The failed
 * URL and error description come from the outside world, so they must never
 * break out into markup. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Build the full error-page HTML for a failed load. Self-contained: inline CSS
 * + one inline script (the Retry navigation). Safe to encode into a data: URL.
 * Visual language mirrors home-doc.ts (Mira is dark-only). */
export function buildErrorPage(err: LoadError): string {
  const { headline, hint } = describeLoadError(err)
  // The retry target is embedded as a JS string, not markup: JSON.stringify
  // escapes quotes/backslashes, and '<' is escaped on top because a literal
  // '</script>' inside the string would close the inline script block.
  const target = JSON.stringify(err.url).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="en">
<!--${ERROR_MARKER}-->
<head><meta charset="utf-8"><title>${escapeHtml(headline)}</title><style>
  :root {
    --bg: #1b1b1f;
    --card: #222226;
    --line: #32363f;
    --t1: rgba(255, 255, 245, 0.86);
    --t2: rgba(235, 235, 245, 0.6);
    --t3: rgba(235, 235, 245, 0.38);
    --accent: #8aa0ff;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background:
      radial-gradient(1200px 600px at 50% -10%, rgba(138, 160, 255, 0.08), transparent 60%),
      var(--bg);
    color: var(--t1);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
    display: flex;
    align-items: center;
    justify-content: center;
    user-select: none;
    cursor: default;
    overflow: hidden;
  }
  .wrap { width: min(560px, 86vw); }
  .badge {
    width: 44px; height: 44px;
    border-radius: 12px;
    background: var(--card);
    border: 1px solid var(--line);
    display: flex; align-items: center; justify-content: center;
    color: var(--accent);
    margin-bottom: 18px;
  }
  h1 { font-size: 26px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 8px; }
  .hint { color: var(--t2); margin: 0 0 22px; }
  .detail {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 14px 16px;
    margin-bottom: 22px;
    font-size: 13px;
  }
  .detail .url {
    color: var(--t1);
    word-break: break-all;
    user-select: text;
    cursor: text;
  }
  .detail .code {
    color: var(--t3);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    margin-top: 6px;
  }
  button {
    font: inherit;
    color: var(--bg);
    background: var(--accent);
    border: none;
    border-radius: 10px;
    padding: 9px 22px;
    font-weight: 600;
    cursor: pointer;
  }
  button:hover { filter: brightness(1.1); }
</style></head>
<body>
  <div class="wrap">
    <div class="badge">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <circle cx="12" cy="12" r="9"></circle>
        <line x1="12" y1="8" x2="12" y2="13"></line>
        <line x1="12" y1="16" x2="12" y2="16"></line>
      </svg>
    </div>
    <h1>${escapeHtml(headline)}</h1>
    <p class="hint">${escapeHtml(hint)}</p>
    <div class="detail">
      <div class="url">${escapeHtml(err.url)}</div>
      <div class="code">${escapeHtml(err.errorDescription)} (${err.errorCode})</div>
    </div>
    <button id="retry" autofocus>Retry</button>
  </div>
  <script>
    document.getElementById('retry').addEventListener('click', function () {
      location.href = ${target};
    });
  </script>
</body>
</html>`
}

/** The error page as a data: URL, ready for view.webContents.loadURL. */
export function errorPageUrl(err: LoadError): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(buildErrorPage(err))}`
}
