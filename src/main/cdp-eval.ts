// Evaluating page JavaScript from the main process (exec-js command, skills,
// probes). The obvious `webContents.executeJavaScript` DOES NOT SETTLE on a tab
// whose webContents already has a CDP debugger attached — and Mira attaches one
// to every content view for the stealth shim (stealth.ts:
// Page.addScriptToEvaluateOnNewDocument). Electron's executeJavaScript and an
// app-attached `webContents.debugger` share the same DevTools transport, and the
// promise never resolves; the socket then writes nothing and the caller hangs
// (extensions-plan.md §8.7, annex bugs). So when a debugger is attached we
// evaluate through it (Runtime.evaluate), which is the same channel stealth
// already drives successfully; otherwise we fall back to executeJavaScript.
//
// TEMP INSTRUMENTATION (extensions-plan.md §8.8): both paths are wrapped in a
// timeout so exec-js can never hang forever, and every branch logs [cdp-eval]
// so we can see, in userData/logs/main-<ts>.log, which path runs and whether it
// resolves/rejects/times out. Remove the logging once exec-js is proven.
import type { WebContents } from 'electron'

/** The subset of a CDP `Runtime.evaluate` reply we read. Loosely typed: it comes
 * across the debugger transport, not from our own code. */
export interface RuntimeEvaluateReply {
  result?: {
    type?: string
    subtype?: string
    value?: unknown
    description?: string
  }
  exceptionDetails?: {
    text?: string
    exception?: { description?: string; value?: unknown }
  }
}

/** Turn a `Runtime.evaluate` reply (called with returnByValue:true) into the
 * evaluated value, or throw an Error carrying the page-side failure. Mirrors what
 * webContents.executeJavaScript resolves/rejects with, so callers are agnostic to
 * which path produced the value. Pure. */
export function interpretRuntimeEvaluate(reply: RuntimeEvaluateReply): unknown {
  const ex = reply.exceptionDetails
  if (ex) {
    const message =
      ex.exception?.description ??
      (typeof ex.exception?.value === 'string' ? ex.exception.value : undefined) ??
      ex.text ??
      'evaluation failed'
    throw new Error(message)
  }
  const result = reply.result
  if (!result) return undefined
  // returnByValue serializes to `value`; an unserializable result (e.g. a raw
  // DOM node with no returnByValue support) leaves only a `description`.
  if ('value' in result) return result.value
  return result.description
}

/** Reject if `p` doesn't settle within `ms`. Used to turn a silent hang into a
 * visible, diagnosable failure. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

const EVAL_TIMEOUT_MS = 5_000

/** Evaluate `code` in a tab's page world and resolve its (JSON-serializable)
 * value. Tries the attached CDP debugger first (reliable under stealth), then
 * executeJavaScript. Neither can hang the caller: each is time-boxed. */
export async function evalInWebContents(wc: WebContents, code: string): Promise<unknown> {
  if (wc.debugger.isAttached()) {
    try {
      const reply = (await withTimeout(
        wc.debugger.sendCommand('Runtime.evaluate', {
          expression: code,
          returnByValue: true,
          awaitPromise: true,
          userGesture: true
        }),
        EVAL_TIMEOUT_MS,
        'cdp Runtime.evaluate'
      )) as RuntimeEvaluateReply
      return interpretRuntimeEvaluate(reply)
    } catch (error) {
      console.warn(`[cdp-eval] Runtime.evaluate failed, falling back to executeJavaScript: ${error}`)
      // fall through to executeJavaScript
    }
  }
  return withTimeout(wc.executeJavaScript(code, true), EVAL_TIMEOUT_MS, 'executeJavaScript')
}
