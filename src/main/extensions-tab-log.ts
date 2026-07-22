// Pure formatter for the forensic tab-lifecycle log that the extension bridge
// emits (see ExtensionsService.addTab/selectTab/removeTab and the per-tab
// navigation hooks). Kept in its own electron-free module so it is unit-testable
// without loading Electron (extensions.ts imports real `app`/`session` values).
//
// Why this log exists: an MV3 extension detects things like "the meeting ended"
// through chrome.tabs.onActivated / onUpdated / onRemoved and runtime messages.
// Those events are driven by exactly these three hooks plus the tab's own
// navigations. When an extension misses such an event (symptom seen with Claap:
// recording never finalized, overlay stuck on "meeting in progress"), the only
// way to tell AFTER THE FACT whether Mira delivered the signal is to have logged
// every one of them to the rotating main log. One greppable line per event,
// prefix `[mira-ext-tab]`, so a later analysis can reconstruct the timeline.

/** Max characters of a url we keep inline before collapsing it — beyond this the
 * line stops being a useful one-glance log entry (the home page is a multi-KB
 * `data:` blob that otherwise floods the terminal). */
const URL_LOG_CAP = 120

/** Shorten a url for the log so one event stays one readable line. A `data:` url
 * collapses to its mediatype prefix plus a length marker (its body is an inline
 * blob, never worth logging in full); any other over-long url is cut at the cap
 * with a `…(N chars)` suffix so the total length is still visible. Short urls
 * pass through untouched. */
function shortenUrlForLog(url: string): string {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',')
    const prefix = comma === -1 ? url.slice(0, URL_LOG_CAP) : url.slice(0, comma)
    return `${prefix},…(${url.length} chars)`
  }
  if (url.length > URL_LOG_CAP) return `${url.slice(0, URL_LOG_CAP)}…(${url.length} chars)`
  return url
}

/** One `[mira-ext-tab]` log line: an event kind, the webContents id it concerns,
 * and the tab url at that moment. `url` may be empty (destroyed tab / no url);
 * an over-long url (notably the `data:` home page) is shortened, see
 * shortenUrlForLog. */
export function formatExtTabLog(kind: string, wcId: number, url: string): string {
  return `[mira-ext-tab] ${kind} wc=${wcId} ${url ? shortenUrlForLog(url) : '(no-url)'}`
}
