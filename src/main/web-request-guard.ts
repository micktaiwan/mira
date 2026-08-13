// Never let a thrown listener hang a request.
//
// Electron allows ONE webRequest listener per event per session, and every
// request in the session waits for that listener to call its callback. Mira
// installs all three (onBeforeRequest / onBeforeSendHeaders / onHeadersReceived)
// as soon as a single extension is loaded — see extensions.ts installWebRequest —
// so every request of every tab goes through Mira's code. The listeners did real
// work before answering: emitting to the chrome.webRequest bridge, matching DNR
// rules, rewriting headers. If ANY of that threw, the callback was never reached
// and Chromium waited on that request forever: no error, no timeout, no log — a
// single subresource silently stuck, which from the page looks like a widget that
// renders empty (and is exactly the shape of the Stripe iframe stall of
// 2026-08-13, see frame-trace.ts).
//
// So the verdict is computed inside a guard: on a throw we answer the NEUTRAL
// verdict — "do nothing to this request", the same answer as having no listener —
// and log the failure. A broken rule must degrade to a plain browser, never to a
// hang. Pure and unit-tested; the caller passes its own log sink.

/** Where a failure line goes. Defaults to console.error, which log.ts tees into
 * the main log file. */
export type GuardLogger = (message: string, error: unknown) => void

const defaultLogger: GuardLogger = (message, error) => console.error(message, error)

/** One log line for a listener that threw. Pure, so the wording is testable. */
export function guardFailureLine(event: string, url: string | undefined): string {
  return `[webRequest] ${event} listener threw, answering neutral: ${url ?? '<no url>'}`
}

/** Run a webRequest listener body and ALWAYS produce a verdict.
 *
 * `neutral` is the answer that leaves the request untouched — `{}` for
 * onBeforeRequest, `{ requestHeaders }` / `{ responseHeaders }` unchanged for the
 * header events. Returning it on a throw keeps the request moving, which is the
 * whole point: a bug in DNR translation or in the extension bridge must cost an
 * extension feature, not the page. */
export function guardedVerdict<T>(
  event: string,
  url: string | undefined,
  neutral: T,
  body: () => T,
  log: GuardLogger = defaultLogger
): T {
  try {
    return body()
  } catch (error) {
    log(guardFailureLine(event, url), error)
    return neutral
  }
}
