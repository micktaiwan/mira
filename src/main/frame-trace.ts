// Trace the frame- and process-level failures Mira used to swallow.
//
// A tab's MAIN frame failing is handled: did-fail-load puts up the error page
// (error-doc.ts) with a Retry button. Everything below that was silent. The
// did-fail-load handler returns early for subframes, and nothing anywhere in the
// main process listened for a renderer process dying — so a cross-origin iframe
// (a payment widget, an auth popup) could fail to load, or have its own process
// killed, and Mira would show an empty box, write nothing to any log, and of
// course never retry. Lived case: a Stripe billing-address iframe left 2px tall
// on a ChatGPT checkout, with no trace in the page console, the Chromium log or
// the main log (2026-08-13) — the whole diagnosis had to be reconstructed from
// the parent page's JS state.
//
// These are TRACES, not recovery. They put the event in the main log with its URL
// so the next occurrence is diagnosable in one grep; re-loading a subframe is the
// page's business, not the browser's. The formatters below are pure so they are
// unit-testable; the glue (profiles.ts wireView, index.ts app wiring) is thin.

/** What did-fail-load reports about a subframe that never loaded. */
export interface SubframeFailure {
  /** did-fail-load's validatedURL — the subframe URL that failed. */
  url: string
  /** Chromium net error code, e.g. -105. */
  errorCode: number
  /** Chromium error name, e.g. "ERR_NAME_NOT_RESOLVED". */
  errorDescription: string
}

/** ERR_ABORTED (-3) is not a failure: it fires when a load is superseded (a stop,
 * a quick re-navigation, an iframe removed mid-load). Same filter the main-frame
 * path applies before showing the error page. */
export function isAbortedLoad(errorCode: number): boolean {
  return errorCode === -3
}

/** One log line for a subframe that failed to load. */
export function subframeFailureLine(f: SubframeFailure): string {
  return `[frame] subframe load failed: ${f.errorDescription} (${f.errorCode}) ${f.url}`
}

/** What Electron reports when a process disappears — the union of
 * `render-process-gone` (reason/exitCode) and `child-process-gone` (which adds
 * the process type and, for utility processes, a service name). */
export interface ProcessGone {
  type?: string
  reason?: string
  exitCode?: number
  serviceName?: string
  name?: string
}

/** A renderer that exited normally is not news: Chromium tears processes down all
 * the time (a tab closed, a frame removed, a process reused). Only abnormal ends
 * are worth a line. */
export function isExpectedExit(reason: string | undefined): boolean {
  return reason === 'clean-exit'
}

/** One log line for a process that died. `scope` says which event saw it — the
 * tab's own renderer (`tab <id>`) or any child process of the app. */
export function processGoneLine(scope: string, d: ProcessGone): string {
  const parts = [d.type, d.serviceName ?? d.name].filter(Boolean).join('/')
  const what = parts ? ` ${parts}` : ''
  const code = typeof d.exitCode === 'number' ? ` exitCode=${d.exitCode}` : ''
  return `[frame] process gone (${scope}):${what} reason=${d.reason ?? 'unknown'}${code}`
}
