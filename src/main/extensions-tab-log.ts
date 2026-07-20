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

/** One `[mira-ext-tab]` log line: an event kind, the webContents id it concerns,
 * and the tab url at that moment. `url` may be empty (destroyed tab / no url). */
export function formatExtTabLog(kind: string, wcId: number, url: string): string {
  return `[mira-ext-tab] ${kind} wc=${wcId} ${url || '(no-url)'}`
}
