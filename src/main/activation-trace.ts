// Pure formatting/classification for the activation trace.
//
// Why this exists: when Mira jumped in front of whatever the user was doing,
// nothing recorded it. Reading the code afterwards always ends the same way —
// every deliberate raise is gated by foreground-policy.ts, so "I see nothing that
// does this" is the only honest conclusion, and it is useless. The native swizzle
// (native/mira-activation) now calls back on EVERY programmatic activation
// attempt; this module turns one such attempt into a log line.
//
// The discriminator is the JS stack captured at the callback. Chromium activates
// the app from C++ (a WebContentsView commit re-focusing its renderer widget), so
// there are no frames of ours on the stack. Our own code activating — app.focus(),
// window.show()/focus() from a command — leaves its call path right there.

/** One activation attempt, as seen from the swizzle. */
export interface ActivationEvent {
  /** When it happened (ms since epoch). */
  at: number
  /** Whether the suppression flag was armed, i.e. the attempt was swallowed. */
  suppressed: boolean
  /** True for activateIgnoringOtherApps:, false for plain activate. */
  ignoring: boolean
  /** `new Error().stack` captured in the observer, or undefined. */
  stack?: string
  /** Free-form state worth freezing with the event (focused window, last command). */
  context?: string
}

/** Where the activation came from, as far as the JS stack can tell.
 * `app` = our own JavaScript asked for it; `chromium` = it came from native code
 * with no JS on the stack (a page commit, a plugin, AppKit). */
export type ActivationSource = 'app' | 'chromium'

/** Frames that are the trace machinery itself, not a caller. */
const SELF_FRAME = /activation-trace|mac-activation/

/** Classify an activation by its captured stack: any frame that is not the trace
 * machinery means our JS drove it. */
export function classifyActivation(stack?: string): ActivationSource {
  if (!stack) return 'chromium'
  const frames = stack
    .split('\n')
    .slice(1) // drop the "Error" header line
    .map((l) => l.trim())
    .filter((l) => l.startsWith('at ') && !SELF_FRAME.test(l))
  return frames.length > 0 ? 'app' : 'chromium'
}

/** The first caller frame worth naming in a one-line log entry. */
export function callerFrame(stack?: string): string {
  if (!stack) return '-'
  for (const line of stack.split('\n').slice(1)) {
    const frame = line.trim()
    if (frame.startsWith('at ') && !SELF_FRAME.test(frame)) return frame.slice(3)
  }
  return '-'
}

/** One log line: timestamp, verdict, source, caller, context. Deliberately a
 * single line so the file greps like a log and not like a stack dump — the full
 * stack goes on continuation lines only when our own code is the source. */
export function formatActivationEntry(event: ActivationEvent): string {
  const source = classifyActivation(event.stack)
  const head = [
    new Date(event.at).toISOString(),
    event.suppressed ? 'SUPPRESSED' : 'ACTIVATED',
    source,
    event.ignoring ? 'ignoringOtherApps' : 'activate',
    callerFrame(event.stack),
    event.context ?? '-'
  ].join(' | ')
  if (source !== 'app' || !event.stack) return head
  const detail = event.stack
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('at ') && !SELF_FRAME.test(l))
    .slice(0, 8)
    .map((l) => `    ${l}`)
    .join('\n')
  return detail ? `${head}\n${detail}` : head
}
