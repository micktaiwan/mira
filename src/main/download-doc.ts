// The Mira download page: what a tab shows when a navigation resolves into a
// file download instead of a rendered page. Chromium aborts the load, so
// without this the tab would sit on a blank void with no hint that a file
// landed in ~/Downloads (lived with an MDM .mobileconfig enroll URL). Like
// error-doc.ts, it is a self-contained HTML document loaded into the tab's
// WebContentsView as a data: URL. While the download runs it shows a
// "Downloading…" state; once done it shows the filename, size and save path
// with Open / Reveal in Finder buttons.
//
// The buttons cannot call the command registry from an unprivileged page, so
// they navigate to a private mira-dl: URL that main intercepts in will-navigate
// (see wireView in profiles.ts) and turns into the open/reveal action.
//
// buildDownloadPage / downloadPageUrl / the mira-dl: helpers are pure and
// tested; profiles.ts calls in from its will-download hook (trackDownload).

import { docThemeVars, type DocTheme } from './doc-theme'
import { formatSize, type DownloadState } from './downloads'

/** A marker embedded in the page as an HTML comment. Its letters survive URL
 * encoding unchanged, so main can recognize "this navigation is our download
 * page" from the data: URL alone (isMiraDownloadUrl) and keep the address bar
 * showing the file's source URL instead of the data: URL. */
const DOWNLOAD_MARKER = 'mira-download-page'

/** True when `url` is the Mira download page. */
export function isMiraDownloadUrl(url: string): boolean {
  return url.includes(DOWNLOAD_MARKER)
}

/** What the download page's buttons can ask main to do with the file. */
export type DownloadAction = 'open' | 'reveal'

/** The private URL a download-page button navigates to, e.g. "mira-dl:open:<id>".
 * The id is the DownloadRecord id minted by the tracker. */
export function downloadActionUrl(action: DownloadAction, id: string): string {
  return `mira-dl:${action}:${id}`
}

/** Parse a mira-dl: action URL back into its action + download id, or null for
 * anything else (a normal navigation must never match). */
export function parseDownloadActionUrl(url: string): { action: DownloadAction; id: string } | null {
  const m = /^mira-dl:(open|reveal):([\w-]+)$/.exec(url)
  if (!m) return null
  return { action: m[1] as DownloadAction, id: m[2] }
}

/** What profiles.ts knows about the download owning the tab. */
export interface DownloadPageInfo {
  /** Tracker id of the download, embedded in the button action URLs. */
  id: string
  state: DownloadState
  filename: string
  /** Source URL the file comes from (shown so the tab keeps its context). */
  url: string
  /** Absolute path the file saves to. */
  savePath: string
  /** Bytes on disk (received so far, or the final size once completed). */
  bytes: number
  /** The active profile's resolved theme, so the page matches the chrome.
   * Absent falls back to the default dark theme. */
  theme?: DocTheme
}

/** Headline + hint per download state. */
export function describeDownloadState(state: DownloadState): { headline: string; hint: string } {
  switch (state) {
    case 'progressing':
      return {
        headline: 'Downloading…',
        hint: 'This address is a file, not a page. Mira is saving it to your Downloads folder.'
      }
    case 'completed':
      return {
        headline: 'File downloaded',
        hint: 'This address was a file, not a page. It has been saved to your Downloads folder.'
      }
    case 'cancelled':
      return {
        headline: 'Download cancelled',
        hint: 'This address was a file, not a page. The download was cancelled before it finished.'
      }
    default:
      return {
        headline: 'Download failed',
        hint: 'This address was a file, not a page, but the download did not complete. Reloading the tab retries it.'
      }
  }
}

/** Escape a value for safe interpolation into HTML text/attributes. The
 * filename and source URL come from the outside world, so they must never
 * break out into markup. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Build the full download-page HTML. Self-contained: inline CSS + one inline
 * script (the button navigations to mira-dl: URLs). Safe to encode into a
 * data: URL. Visual language mirrors error-doc.ts. */
export function buildDownloadPage(info: DownloadPageInfo): string {
  const { headline, hint } = describeDownloadState(info.state)
  const sizeText = info.bytes > 0 ? formatSize(info.bytes) : ''
  const completed = info.state === 'completed'
  // The action targets are embedded as JS strings, not markup: JSON.stringify
  // escapes quotes/backslashes ('<' cannot appear in a mira-dl: URL, the id is
  // \w- only).
  const openTarget = JSON.stringify(downloadActionUrl('open', info.id))
  const revealTarget = JSON.stringify(downloadActionUrl('reveal', info.id))
  return `<!doctype html>
<html lang="en">
<!--${DOWNLOAD_MARKER}-->
<head><meta charset="utf-8"><title>${escapeHtml(completed ? `Downloaded ${info.filename}` : headline)}</title><style>
  :root {
    ${docThemeVars(info.theme)}
    --bg: var(--surface);
    --card: var(--surface-raised);
    --line: var(--border-subtle);
    --t1: var(--text);
    --t2: var(--text-muted);
    --t3: var(--text-faint);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background:
      radial-gradient(1200px 600px at 50% -10%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 60%),
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
  .detail .file {
    color: var(--t1);
    font-weight: 600;
    word-break: break-all;
    user-select: text;
    cursor: text;
  }
  .detail .size { color: var(--t2); margin-top: 2px; }
  .detail .url {
    color: var(--t3);
    word-break: break-all;
    user-select: text;
    cursor: text;
    margin-top: 6px;
    font-size: 12px;
  }
  button {
    font: inherit;
    border-radius: 10px;
    padding: 9px 22px;
    font-weight: 600;
    cursor: pointer;
  }
  #open {
    color: var(--bg);
    background: var(--accent);
    border: none;
  }
  #open:hover { filter: brightness(1.1); }
  #reveal {
    color: var(--t1);
    background: var(--card);
    border: 1px solid var(--line);
    margin-left: 10px;
  }
  #reveal:hover { border-color: var(--t3); }
</style></head>
<body>
  <div class="wrap">
    <div class="badge">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 4v11"></path>
        <path d="M7 10l5 5 5-5"></path>
        <path d="M5 19h14"></path>
      </svg>
    </div>
    <h1>${escapeHtml(headline)}</h1>
    <p class="hint">${escapeHtml(hint)}</p>
    <div class="detail">
      <div class="file">${escapeHtml(info.filename)}</div>
      ${sizeText ? `<div class="size">${escapeHtml(sizeText)}</div>` : ''}
      <div class="url">${escapeHtml(info.url)}</div>
    </div>
    ${
      completed
        ? `<button id="open" autofocus>Open</button><button id="reveal">Reveal in Finder</button>`
        : ''
    }
  </div>
  ${
    completed
      ? `<script>
    document.getElementById('open').addEventListener('click', function () {
      location.href = ${openTarget};
    });
    document.getElementById('reveal').addEventListener('click', function () {
      location.href = ${revealTarget};
    });
  </script>`
      : ''
  }
</body>
</html>`
}

/** The download page as a data: URL, ready for view.webContents.loadURL. */
export function downloadPageUrl(info: DownloadPageInfo): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(buildDownloadPage(info))}`
}
