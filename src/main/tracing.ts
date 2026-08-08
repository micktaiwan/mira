// Chromium content tracing: record what EVERY Mira process is doing, so a stall
// that lasts seconds can be attributed to a named inter-process message instead
// of guessed at.
//
// Why this exists. Mira has no synchronous IPC of its own — there is not one
// `sendSync` nor one `ipcMain.on` in src/. So when a renderer's main thread is
// found sitting in `mach_msg` during the Google Photos locked-folder stall (see
// track.md), a `sample` can only report "waiting on Mach"; it can never say on
// WHAT, nor even distinguish a real block from an idle event loop. A content
// trace records each message with its name and duration, which is exactly the
// missing piece. The output is a JSON file, readable in chrome://tracing or on
// ui.perfetto.dev.
//
// Shape: parameter parsing, config building and file naming are pure and
// unit-tested. `TracingSession` is the thin shell around the native API, and it
// takes that API as a constructor argument so it is testable without Electron.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { logTimestamp } from './log'

/** Chromium's buffer strategies. `trace-to-console` is deliberately absent: it
 * dumps to stdout instead of producing a file, which is useless here. */
export type TraceRecordingMode =
  'record-until-full' | 'record-continuously' | 'record-as-much-as-possible'

export const TRACE_RECORDING_MODES: readonly TraceRecordingMode[] = [
  'record-until-full',
  'record-continuously',
  'record-as-much-as-possible'
]

/** Categories aimed at an IPC/navigation stall, one line of reasoning each:
 *
 *  - toplevel / sequence_manager — every message-loop task with its duration.
 *    Together they answer the first question: is the thread running a long task
 *    or is it doing nothing at all?
 *  - ipc, mojom — the inter-process messages themselves, by interface name.
 *    This is what turns "waiting on Mach" into "waiting on <interface>.<method>".
 *  - disabled-by-default-ipc.flow — the detailed send→receive linking. It is
 *    off unless asked for by name (hence the prefix), and it is the one that
 *    pairs a blocked caller with the process that owes it an answer.
 *  - navigation, net — the stall sits between two navigations, so these say
 *    whether anything was ever sent on the wire during the gap.
 *  - latency — input and responsiveness events.
 *  - electron — Electron's own category, added on top of Chromium's.
 *
 * Chromium only enables categories that exist in the running build; use the
 * `tracing-categories` command to list what this build actually offers. */
export const DEFAULT_TRACE_CATEGORIES: readonly string[] = [
  'toplevel',
  'toplevel.flow',
  'sequence_manager',
  'ipc',
  'mojom',
  'disabled-by-default-ipc.flow',
  'navigation',
  'net',
  'latency',
  'electron'
]

/** 100 MB, Chromium's own default. Big enough that a ring buffer holds minutes
 * of the categories above, small enough not to weigh on a warm Mac. */
export const DEFAULT_TRACE_BUFFER_KB = 100_000

export interface TraceStart {
  categories: string[]
  bufferKb: number
  mode: TraceRecordingMode
}

/** The subset of Electron's TraceConfig we emit. Declared structurally so this
 * module never imports electron (keeps it unit-testable). */
export interface TraceConfigLike {
  included_categories: string[]
  trace_buffer_size_in_kb: number
  recording_mode: TraceRecordingMode
}

/** Validate and default the params of `start-tracing`. Throws with a caller-
 * facing message; the command turns that into `{ ok: false }`.
 *
 * The default mode is `record-continuously` — a ring buffer — because the stall
 * this was built for is intermittent: you start recording, wait for it to
 * happen (possibly minutes), then stop. Only a ring keeps the recent past
 * instead of filling up on the wait and dropping the episode itself. */
export function parseTraceParams(params: unknown): TraceStart {
  const raw = (params ?? {}) as Partial<{
    categories: unknown
    bufferKb: unknown
    mode: unknown
  }>

  let categories = [...DEFAULT_TRACE_CATEGORIES]
  if (raw.categories !== undefined) {
    if (
      !Array.isArray(raw.categories) ||
      raw.categories.length === 0 ||
      raw.categories.some((c) => typeof c !== 'string' || c.trim() === '')
    ) {
      throw new Error('invalid "categories" (expected a non-empty array of strings)')
    }
    categories = (raw.categories as string[]).map((c) => c.trim())
  }

  let bufferKb = DEFAULT_TRACE_BUFFER_KB
  if (raw.bufferKb !== undefined) {
    if (typeof raw.bufferKb !== 'number' || !Number.isInteger(raw.bufferKb) || raw.bufferKb <= 0) {
      throw new Error('invalid "bufferKb" (expected a positive integer)')
    }
    bufferKb = raw.bufferKb
  }

  let mode: TraceRecordingMode = 'record-continuously'
  if (raw.mode !== undefined) {
    if (!TRACE_RECORDING_MODES.includes(raw.mode as TraceRecordingMode)) {
      throw new Error(`invalid "mode" (${TRACE_RECORDING_MODES.join('|')})`)
    }
    mode = raw.mode as TraceRecordingMode
  }

  return { categories, bufferKb, mode }
}

/** The Chromium trace config for a parsed start. Pure. */
export function traceConfig(start: TraceStart): TraceConfigLike {
  return {
    included_categories: start.categories,
    trace_buffer_size_in_kb: start.bufferKb,
    recording_mode: start.mode
  }
}

/** Sortable trace file name, same timestamp shape as the log files so a trace
 * and the logs of the same moment line up by name. */
export function traceFileName(at: Date): string {
  return `trace-${logTimestamp(at)}.json`
}

/** The bit of Electron's contentTracing we use, structurally typed so tests can
 * pass a stub. */
export interface ContentTracingLike {
  startRecording: (options: TraceConfigLike) => Promise<void>
  stopRecording: (resultFilePath?: string) => Promise<string>
  getCategories: () => Promise<string[]>
}

/** One recording at a time, process-wide. That is Chromium's constraint, not
 * ours: a second startRecording resolves immediately without starting anything,
 * and a stopRecording with nothing running rejects. Tracking the state here
 * turns both into an explicit error instead of a silent no-op. */
export class TracingSession {
  private active = false

  constructor(
    private readonly tracing: ContentTracingLike,
    private readonly traceDir: string
  ) {}

  isActive(): boolean {
    return this.active
  }

  async start(start: TraceStart): Promise<TraceStart> {
    if (this.active) throw new Error('a trace recording is already running')
    await this.tracing.startRecording(traceConfig(start))
    this.active = true
    return start
  }

  /** Stop and flush to `traceDir/trace-<timestamp>.json`, returning that path.
   * Child processes only flush their cached trace data on stop, so this can
   * take a moment on a long recording. */
  async stop(at: Date): Promise<string> {
    if (!this.active) throw new Error('no trace recording is running')
    mkdirSync(this.traceDir, { recursive: true })
    const path = join(this.traceDir, traceFileName(at))
    try {
      return await this.tracing.stopRecording(path)
    } finally {
      // Cleared even if the flush throws: Chromium has stopped recording either
      // way, so keeping `active` true would strand the session with no way back.
      this.active = false
    }
  }

  /** The category groups this build actually offers. Grows as new code paths
   * are reached, so it is a live answer, not a constant. */
  async categories(): Promise<string[]> {
    return this.tracing.getCategories()
  }
}
