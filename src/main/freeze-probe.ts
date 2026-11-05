// Name the code behind a frozen page. A page stuck in a JS loop answers nothing:
// exec-js times out, its console goes quiet and `sample` only shows anonymous JIT
// addresses. CDP's `Debugger.pause` is one of the few commands Chromium delivers by
// interrupting the running script, so pausing a few times and reading the stack
// gives the script, the function and the position that hold the main thread.
//
// `Debugger.enable` is NOT such a command: it waits for the main thread like any
// other, so it has to land BEFORE the freeze (arm, then reload). `arm` also starts
// a recorder of what loaded and when. An unarmed frozen page is still reported as
// frozen, with the reason the stack is missing.
//
// Arming can change what it observes: a site's obfuscated third-party module froze
// with the Debugger domain enabled and ran without it (measured 2026-10-31). Off by default,
// and a stack from an armed page says where the code spins, not why.
//
// The sampling and the summary are pure and unit-tested over a fake debugger.

/** The part of `webContents.debugger` the probe needs. */
export interface ProbeDebugger {
  isAttached: () => boolean
  attach: (version: string) => void
  sendCommand: (method: string, params?: object) => Promise<unknown>
  on: (event: 'message', listener: (e: unknown, method: string, params: unknown) => void) => unknown
  removeListener: (event: 'message', listener: (...args: never[]) => void) => unknown
}

export interface ProbeFrame {
  functionName: string
  url: string
  line: number
  column: number
}

export interface LoadEvent {
  atMs: number
  kind: 'script' | 'request' | 'response' | 'failed'
  url: string
  detail?: string
}

export interface FreezeProbeResult {
  /** The page answered a trivial evaluation in time. */
  responsive: boolean
  armed: boolean
  samplesTaken: number
  /** Why there is no stack, when there is none. */
  note?: string
  /** Distinct stacks, most frequent first. */
  stacks: { count: number; frames: ProbeFrame[] }[]
  /** Source around the top frame of the most frequent stack. */
  snippet?: string
  /** What the page loaded since arming, oldest first. */
  timeline: LoadEvent[]
  terminated?: boolean
}

export const DEFAULT_SAMPLES = 5
const MAX_SAMPLES = 20
const MAX_FRAMES = 12
const MAX_TIMELINE = 300
const HEARTBEAT_MS = 1_500
const PAUSE_MS = 3_000
const SNIPPET_RADIUS = 160

function timeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
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

/** Turn one `Debugger.paused` payload into frames. Pure. `urls` maps scriptId → url. */
export function framesFromPause(params: unknown, urls: ReadonlyMap<string, string>): ProbeFrame[] {
  const callFrames = (params as { callFrames?: unknown[] })?.callFrames
  if (!Array.isArray(callFrames)) return []
  return callFrames.slice(0, MAX_FRAMES).map((raw) => {
    const f = raw as {
      functionName?: string
      url?: string
      location?: { scriptId?: string; lineNumber?: number; columnNumber?: number }
    }
    const scriptId = f.location?.scriptId ?? ''
    return {
      functionName: f.functionName || '(anonymous)',
      url: f.url || urls.get(scriptId) || `script:${scriptId}`,
      line: f.location?.lineNumber ?? 0,
      column: f.location?.columnNumber ?? 0
    }
  })
}

/** Group identical stacks, most frequent first. Pure. */
export function summarizeStacks(samples: ProbeFrame[][]): FreezeProbeResult['stacks'] {
  const byKey = new Map<string, { count: number; frames: ProbeFrame[] }>()
  for (const frames of samples) {
    const key = frames.map((f) => `${f.url}:${f.line}:${f.column}`).join('|')
    const hit = byKey.get(key)
    if (hit) hit.count++
    else byKey.set(key, { count: 1, frames })
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count)
}

/** The source around a position. Pure. Obfuscated bundles are one huge line, hence
 * a window of characters rather than whole lines. */
export function snippetAround(source: string, line: number, column: number): string {
  const lines = source.split('\n')
  const text = lines[line] ?? ''
  const from = Math.max(0, column - SNIPPET_RADIUS)
  return text.slice(from, column) + '⟦HERE⟧' + text.slice(column, column + SNIPPET_RADIUS)
}

/** One load-timeline event from a CDP message, or null. Pure. Data URLs are dropped:
 * they are noise, and they can be huge. */
export function loadEventFrom(method: string, params: unknown, atMs: number): LoadEvent | null {
  const p = (params ?? {}) as {
    url?: string
    request?: { url?: string }
    response?: { url?: string; status?: number }
    errorText?: string
    requestId?: string
  }
  const keep = (url: string | undefined): url is string => !!url && !url.startsWith('data:')
  if (method === 'Debugger.scriptParsed')
    return keep(p.url) ? { atMs, kind: 'script', url: p.url } : null
  if (method === 'Network.requestWillBeSent')
    return keep(p.request?.url) ? { atMs, kind: 'request', url: p.request.url } : null
  if (method === 'Network.responseReceived')
    return keep(p.response?.url)
      ? { atMs, kind: 'response', url: p.response.url, detail: String(p.response.status ?? '') }
      : null
  if (method === 'Network.loadingFailed')
    return { atMs, kind: 'failed', url: p.requestId ?? '', detail: p.errorText }
  return null
}

interface ArmedState {
  urls: Map<string, string>
  timeline: LoadEvent[]
  startedAt: number
  listener: (e: unknown, method: string, params: unknown) => void
}

const armedByDebugger = new WeakMap<ProbeDebugger, ArmedState>()

export function isFreezeProbeArmed(dbg: ProbeDebugger): boolean {
  return armedByDebugger.has(dbg)
}

/** Enable the Debugger and Network domains and record what loads. Idempotent. Must run
 * on a page that still answers; reload afterwards to catch a freeze during load. */
export async function armFreezeProbe(
  dbg: ProbeDebugger,
  now: () => number = Date.now
): Promise<{ armed: true; alreadyArmed: boolean }> {
  if (armedByDebugger.has(dbg)) return { armed: true, alreadyArmed: true }
  if (!dbg.isAttached()) dbg.attach('1.3')
  const state: ArmedState = {
    urls: new Map(),
    timeline: [],
    startedAt: now(),
    listener: (_e, method, params) => {
      if (method === 'Debugger.scriptParsed') {
        const p = params as { scriptId?: string; url?: string }
        if (p.scriptId && p.url) state.urls.set(p.scriptId, p.url)
      }
      const event = loadEventFrom(method, params, now() - state.startedAt)
      if (!event) return
      state.timeline.push(event)
      if (state.timeline.length > MAX_TIMELINE) state.timeline.shift()
    }
  }
  dbg.on('message', state.listener)
  try {
    await timeout(dbg.sendCommand('Debugger.enable'), HEARTBEAT_MS, 'Debugger.enable')
  } catch (error) {
    // The queued enable may still land once the page is free: take it back too.
    dbg.removeListener('message', state.listener as never)
    dbg.sendCommand('Debugger.disable').catch(() => {})
    throw error
  }
  dbg.sendCommand('Network.enable').catch(() => {})
  armedByDebugger.set(dbg, state)
  return { armed: true, alreadyArmed: false }
}

/** Resume, bounded: a resume that never answers must not hang the whole probe. */
function resume(dbg: ProbeDebugger, ms: number): Promise<unknown> {
  return timeout(dbg.sendCommand('Debugger.resume'), ms, 'Debugger.resume').catch(() => {})
}

/** Pause once and read the stack. Resolves null when no pause arrives in time. */
async function sampleOnce(
  dbg: ProbeDebugger,
  urls: ReadonlyMap<string, string>,
  pauseMs: number
): Promise<{ frames: ProbeFrame[]; scriptId?: string } | null> {
  let listener: ((e: unknown, method: string, params: unknown) => void) | undefined
  const paused = new Promise<unknown>((resolve) => {
    listener = (_e, method, params) => {
      if (method === 'Debugger.paused') resolve(params)
    }
    dbg.on('message', listener)
  })
  try {
    dbg.sendCommand('Debugger.pause').catch(() => {})
    const params = await timeout(paused, pauseMs, 'Debugger.paused').catch(() => null)
    if (!params) {
      // The pause request stays pending and would stop the page's next script with
      // nobody left to resume it (measured: exec-js then timed out on a healthy page).
      // Debugger.resume does not clear it; turning the domain off and on does.
      await timeout(dbg.sendCommand('Debugger.disable'), pauseMs, 'Debugger.disable').catch(() => {})
      dbg.sendCommand('Debugger.enable').catch(() => {})
      return null
    }
    const first = (params as { callFrames?: { location?: { scriptId?: string } }[] })
      .callFrames?.[0]
    return { frames: framesFromPause(params, urls), scriptId: first?.location?.scriptId }
  } finally {
    if (listener) dbg.removeListener('message', listener as never)
  }
}

/** Report whether a page answers and, when armed, which code holds its main thread.
 * `terminate` also aborts the running script (`Runtime.terminateExecution`), which
 * frees a frozen page without killing it. */
export async function runFreezeProbe(
  dbg: ProbeDebugger,
  opts: { samples?: number; terminate?: boolean; pauseMs?: number; heartbeatMs?: number } = {}
): Promise<FreezeProbeResult> {
  const samples = Math.min(Math.max(1, opts.samples ?? DEFAULT_SAMPLES), MAX_SAMPLES)
  const pauseMs = opts.pauseMs ?? PAUSE_MS
  if (!dbg.isAttached()) dbg.attach('1.3')
  const responsive = await timeout(
    dbg.sendCommand('Runtime.evaluate', { expression: '1', returnByValue: true }),
    opts.heartbeatMs ?? HEARTBEAT_MS,
    'heartbeat'
  ).then(
    () => true,
    () => false
  )
  const state = armedByDebugger.get(dbg)
  const taken: ProbeFrame[][] = []
  let snippet: string | undefined
  let note: string | undefined
  if (!state) {
    note = responsive
      ? 'not armed: run arm-freeze-probe, then reload the page to catch a freeze during load'
      : 'frozen and not armed: Debugger.enable cannot reach a blocked main thread. Reload the tab, arm it while it answers, then reload again'
  } else if (responsive) {
    // Nothing holds the thread, and a pause on an idle page would hit the next script.
    note = 'the page answers: nothing to sample'
  } else {
    for (let i = 0; i < samples; i++) {
      const sample = await sampleOnce(dbg, state.urls, pauseMs)
      if (!sample) break
      taken.push(sample.frames)
      const top = sample.frames[0]
      if (snippet === undefined && top && sample.scriptId) {
        const source = (await timeout(
          dbg.sendCommand('Debugger.getScriptSource', { scriptId: sample.scriptId }),
          pauseMs,
          'getScriptSource'
        ).catch(() => null)) as { scriptSource?: string } | null
        if (source?.scriptSource) snippet = snippetAround(source.scriptSource, top.line, top.column)
      }
      await resume(dbg, pauseMs)
    }
    if (taken.length === 0) note = 'the page does not answer and no pause arrived'
  }
  let terminated: boolean | undefined
  if (opts.terminate) {
    terminated = await timeout(
      dbg.sendCommand('Runtime.terminateExecution'),
      pauseMs,
      'terminateExecution'
    ).then(
      () => true,
      () => false
    )
  }
  return {
    responsive,
    armed: !!state,
    samplesTaken: taken.length,
    ...(note ? { note } : {}),
    stacks: summarizeStacks(taken),
    ...(snippet ? { snippet } : {}),
    timeline: state ? [...state.timeline] : [],
    ...(terminated !== undefined ? { terminated } : {})
  }
}
