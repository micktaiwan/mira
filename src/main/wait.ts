// Waiting for a condition to hold in a page — the pure half of the `wait-for`
// command. The polling loop, the probe scripts and the parameter parsing live
// here so they are unit-testable without Electron; profiles.ts only supplies a
// real page evaluator and a real clock.
//
// Why the command exists at all: without it, a script driving Mira writes
// `sleep 3`. That is too long when the page is already there (the whole felt
// slowness of automation) and too short when it is not — and the short case is
// the dangerous one, because it does not read as "too early", it reads as "the
// element does not exist", one or two hundred milliseconds before it appears.
//
// ⚠️ The polling deliberately runs as MANY short evaluations rather than one
// long `await` inside the page: exec-js is capped at 5 s (cdp-eval.ts), so a
// single in-page wait would die at five seconds no matter what timeout the
// caller asked for.

/** What to wait for. `gone` inverts the condition (wait for it to stop holding). */
export interface WaitCondition {
  kind: 'selector' | 'text' | 'url'
  value: string
  gone: boolean
}

/** Default budget, in ms, when the caller names none. */
export const DEFAULT_WAIT_MS = 5000
/** How long between two probes. Short enough to feel instant, long enough that a
 * 30 s wait is 300 evaluations rather than thirty thousand. */
export const WAIT_POLL_MS = 100
/** Upper bound on a caller-supplied timeout: past this, a wait is a hang. */
export const MAX_WAIT_MS = 300000

export interface ParsedWait {
  condition: WaitCondition
  timeoutMs: number
  tabId?: string
}

/** Validate the `wait-for` params. Exactly one of selector/text/url: two
 * conditions in one call would silently wait on whichever we happened to check,
 * which is the kind of ambiguity that makes an automation script unexplainable. */
export function parseWaitParams(params: unknown): ParsedWait | { error: string } {
  const p = (params ?? {}) as Record<string, unknown>
  const named = (['selector', 'text', 'url'] as const).filter(
    (k) => typeof p[k] === 'string' && (p[k] as string).length > 0
  )
  if (named.some((k) => typeof p[k] !== 'string')) return { error: 'invalid condition' }
  if (named.length === 0) return { error: 'missing condition: "selector", "text" or "url"' }
  if (named.length > 1) {
    return { error: `one condition at a time, got ${named.map((k) => `"${k}"`).join(' and ')}` }
  }
  if (p.tabId !== undefined && (typeof p.tabId !== 'string' || p.tabId.trim() === '')) {
    return { error: 'invalid "tabId"' }
  }
  let timeoutMs = DEFAULT_WAIT_MS
  if (p.timeoutMs !== undefined) {
    if (typeof p.timeoutMs !== 'number' || !Number.isFinite(p.timeoutMs) || p.timeoutMs <= 0) {
      return { error: '"timeoutMs" must be a positive number of milliseconds' }
    }
    if (p.timeoutMs > MAX_WAIT_MS) return { error: `"timeoutMs" is capped at ${MAX_WAIT_MS}` }
    timeoutMs = Math.round(p.timeoutMs)
  }
  const kind = named[0]
  const out: ParsedWait = {
    condition: { kind, value: p[kind] as string, gone: p.gone === true },
    timeoutMs
  }
  if (typeof p.tabId === 'string') out.tabId = p.tabId
  return out
}

/** JSON.stringify is the only correct way to inject a caller's string into a
 * script: a css selector or a piece of text may hold quotes, backslashes or
 * newlines, and concatenating them would either break the parse or, worse, run. */
function literal(value: string): string {
  return JSON.stringify(value)
}

/** The page-side expression that answers "does the condition hold, right now?".
 * Always an expression returning a boolean, evaluated fresh on every probe. */
export function waitProbeScript(condition: WaitCondition): string {
  const v = literal(condition.value)
  let holds: string
  if (condition.kind === 'selector') {
    // Present is not enough: an element can be in the DOM with a zero box (a
    // dialog still animating in, a `display:none` template). Clicking it would
    // fail, so it does not count as "there yet".
    holds = `(() => { const el = document.querySelector(${v}); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 })()`
  } else if (condition.kind === 'text') {
    // innerText, not textContent: it is the RENDERED text, so hidden nodes and
    // <script> bodies do not count as the text being on screen.
    holds = `(document.body ? document.body.innerText : '').includes(${v})`
  } else {
    holds = `location.href.includes(${v})`
  }
  return condition.gone ? `!(${holds})` : `(${holds})`
}

/** One line naming what was waited for, for both the success and the timeout
 * message. The caller must never have to guess what the command actually
 * watched. */
export function describeCondition(condition: WaitCondition): string {
  const what =
    condition.kind === 'selector'
      ? `selector ${JSON.stringify(condition.value)}`
      : condition.kind === 'text'
        ? `text ${JSON.stringify(condition.value)}`
        : `url containing ${JSON.stringify(condition.value)}`
  return `${what} ${condition.gone ? 'gone' : 'present'}`
}

export interface PollOptions {
  /** Evaluate the condition once. A throw counts as "not yet": a page that is
   * mid-navigation rejects evaluations for a beat, and that is precisely the
   * moment worth waiting through. */
  probe: () => Promise<boolean>
  timeoutMs: number
  intervalMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** Poll until the condition holds or the budget runs out. Returns how long it
 * actually took, so the caller can see what the wait cost instead of assuming
 * the timeout. */
export async function pollUntil(
  opts: PollOptions
): Promise<{ ok: boolean; waitedMs: number; lastError?: string }> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const interval = opts.intervalMs ?? WAIT_POLL_MS
  const started = now()
  let lastError: string | undefined
  for (;;) {
    try {
      if (await opts.probe()) return { ok: true, waitedMs: now() - started }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    const elapsed = now() - started
    if (elapsed >= opts.timeoutMs) return { ok: false, waitedMs: elapsed, lastError }
    await sleep(Math.min(interval, opts.timeoutMs - elapsed))
  }
}

/** The timeout message. It says what was watched and for how long — never a bare
 * "timed out", which leaves the caller unable to tell a wrong selector from a
 * slow page. */
export function waitTimeoutMessage(
  condition: WaitCondition,
  waitedMs: number,
  lastError?: string
): string {
  const tail = lastError ? ` (last page error: ${lastError})` : ''
  return `timed out after ${waitedMs}ms waiting for ${describeCondition(condition)}${tail}`
}
