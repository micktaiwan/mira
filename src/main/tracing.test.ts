import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseTraceParams,
  traceConfig,
  traceFileName,
  TracingSession,
  DEFAULT_TRACE_CATEGORIES,
  DEFAULT_TRACE_BUFFER_KB,
  type ContentTracingLike,
  type TraceConfigLike
} from './tracing'

/** A stub of Electron's contentTracing that records what it was asked to do. */
function fakeTracing(overrides: Partial<ContentTracingLike> = {}): ContentTracingLike & {
  started: TraceConfigLike[]
  stoppedAt: (string | undefined)[]
} {
  const started: TraceConfigLike[] = []
  const stoppedAt: (string | undefined)[] = []
  return {
    started,
    stoppedAt,
    startRecording: async (options) => {
      started.push(options)
    },
    stopRecording: async (path) => {
      stoppedAt.push(path)
      return path ?? '/tmp/electron-default.json'
    },
    getCategories: async () => ['toplevel', 'ipc', 'mojom'],
    ...overrides
  }
}

describe('parseTraceParams', () => {
  it('defaults to the stall-hunting categories and a ring buffer', () => {
    const start = parseTraceParams(undefined)
    expect(start.categories).toEqual([...DEFAULT_TRACE_CATEGORIES])
    expect(start.bufferKb).toBe(DEFAULT_TRACE_BUFFER_KB)
    // A ring, so waiting minutes for an intermittent stall does not fill the
    // buffer before the episode happens.
    expect(start.mode).toBe('record-continuously')
  })

  it('accepts and trims explicit categories', () => {
    expect(parseTraceParams({ categories: [' ipc ', 'mojom'] }).categories).toEqual([
      'ipc',
      'mojom'
    ])
  })

  it('rejects an empty or malformed category list', () => {
    expect(() => parseTraceParams({ categories: [] })).toThrow(/categories/)
    expect(() => parseTraceParams({ categories: 'ipc' })).toThrow(/categories/)
    expect(() => parseTraceParams({ categories: ['ipc', ''] })).toThrow(/categories/)
  })

  it('rejects a non-positive or fractional buffer size', () => {
    expect(() => parseTraceParams({ bufferKb: 0 })).toThrow(/bufferKb/)
    expect(() => parseTraceParams({ bufferKb: -1 })).toThrow(/bufferKb/)
    expect(() => parseTraceParams({ bufferKb: 1.5 })).toThrow(/bufferKb/)
    expect(parseTraceParams({ bufferKb: 20_000 }).bufferKb).toBe(20_000)
  })

  it('accepts the known modes and rejects the rest', () => {
    expect(parseTraceParams({ mode: 'record-until-full' }).mode).toBe('record-until-full')
    expect(() => parseTraceParams({ mode: 'trace-to-console' })).toThrow(/mode/)
    expect(() => parseTraceParams({ mode: 'nope' })).toThrow(/mode/)
  })
})

describe('traceConfig', () => {
  it('maps a parsed start onto Chromium field names', () => {
    expect(traceConfig({ categories: ['ipc'], bufferKb: 42, mode: 'record-until-full' })).toEqual({
      included_categories: ['ipc'],
      trace_buffer_size_in_kb: 42,
      recording_mode: 'record-until-full'
    })
  })
})

describe('traceFileName', () => {
  it('shares the sortable timestamp shape of the log files', () => {
    expect(traceFileName(new Date(2026, 7, 5, 10, 45, 14))).toBe('trace-2026-08-05T10-45-14.json')
  })
})

describe('TracingSession', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mira-trace-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('starts with the built config and reports itself active', async () => {
    const tracing = fakeTracing()
    const session = new TracingSession(tracing, join(dir, 'traces'))
    expect(session.isActive()).toBe(false)
    await session.start(parseTraceParams({ categories: ['ipc'], bufferKb: 10 }))
    expect(session.isActive()).toBe(true)
    expect(tracing.started).toEqual([
      {
        included_categories: ['ipc'],
        trace_buffer_size_in_kb: 10,
        recording_mode: 'record-continuously'
      }
    ])
  })

  it('refuses a second start instead of silently doing nothing', async () => {
    const session = new TracingSession(fakeTracing(), join(dir, 'traces'))
    await session.start(parseTraceParams(undefined))
    await expect(session.start(parseTraceParams(undefined))).rejects.toThrow(/already running/)
  })

  it('refuses to stop when nothing is running', async () => {
    const session = new TracingSession(fakeTracing(), join(dir, 'traces'))
    await expect(session.stop(new Date())).rejects.toThrow(/no trace recording/)
  })

  it('creates the trace directory and stops into a timestamped file', async () => {
    const tracing = fakeTracing()
    const traceDir = join(dir, 'traces')
    const session = new TracingSession(tracing, traceDir)
    await session.start(parseTraceParams(undefined))
    const path = await session.stop(new Date(2026, 7, 5, 10, 45, 14))
    expect(existsSync(traceDir)).toBe(true)
    expect(path).toBe(join(traceDir, 'trace-2026-08-05T10-45-14.json'))
    expect(tracing.stoppedAt).toEqual([path])
    expect(session.isActive()).toBe(false)
  })

  it('goes inactive even when the flush throws, so the session is not stranded', async () => {
    const tracing = fakeTracing({
      stopRecording: async () => {
        throw new Error('flush failed')
      }
    })
    const session = new TracingSession(tracing, join(dir, 'traces'))
    await session.start(parseTraceParams(undefined))
    await expect(session.stop(new Date())).rejects.toThrow(/flush failed/)
    expect(session.isActive()).toBe(false)
    // And a fresh recording can start again.
    await expect(session.start(parseTraceParams(undefined))).resolves.toBeTruthy()
  })

  it('passes through the live category list of the running build', async () => {
    const session = new TracingSession(fakeTracing(), join(dir, 'traces'))
    expect(await session.categories()).toEqual(['toplevel', 'ipc', 'mojom'])
  })
})
