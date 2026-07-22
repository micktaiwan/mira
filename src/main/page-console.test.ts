import { describe, it, expect } from 'vitest'
import {
  PageConsoleStore,
  consoleApiLevel,
  consoleArgsToMessage,
  remoteObjectToText,
  logEntryLevel,
  logEntrySource,
  draftFromConsoleApi,
  draftFromLogEntry,
  draftFromException,
  draftFromCdpMessage,
  isPageLogLevel
} from './page-console'

describe('level mapping', () => {
  it('maps console API types to levels', () => {
    expect(consoleApiLevel('error')).toBe('error')
    expect(consoleApiLevel('assert')).toBe('error')
    expect(consoleApiLevel('warning')).toBe('warning')
    expect(consoleApiLevel('debug')).toBe('verbose')
    expect(consoleApiLevel('trace')).toBe('verbose')
    expect(consoleApiLevel('log')).toBe('info')
    expect(consoleApiLevel('info')).toBe('info')
    expect(consoleApiLevel('table')).toBe('info')
  })

  it('maps CDP log levels, defaulting unknowns to info', () => {
    expect(logEntryLevel('error')).toBe('error')
    expect(logEntryLevel('warning')).toBe('warning')
    expect(logEntryLevel('verbose')).toBe('verbose')
    expect(logEntryLevel(undefined)).toBe('info')
    expect(logEntryLevel('bogus')).toBe('info')
  })

  it('categorizes log entry sources', () => {
    expect(logEntrySource('network')).toBe('network')
    expect(logEntrySource('security')).toBe('security')
    expect(logEntrySource('javascript')).toBe('other')
    expect(logEntrySource(undefined)).toBe('other')
  })

  it('validates level names', () => {
    expect(isPageLogLevel('error')).toBe(true)
    expect(isPageLogLevel('fatal')).toBe(false)
    expect(isPageLogLevel(3)).toBe(false)
  })
})

describe('remote object rendering', () => {
  it('renders primitives by value and objects by description', () => {
    expect(remoteObjectToText({ type: 'string', value: 'hi' })).toBe('hi')
    expect(remoteObjectToText({ type: 'number', value: 403 })).toBe('403')
    expect(remoteObjectToText({ type: 'boolean', value: false })).toBe('false')
    expect(remoteObjectToText({ type: 'object', description: 'Error: boom' })).toBe('Error: boom')
    expect(remoteObjectToText({ type: 'undefined' })).toBe('undefined')
    expect(remoteObjectToText({ type: 'number', unserializableValue: 'NaN' })).toBe('NaN')
  })

  it('joins multiple args with spaces', () => {
    expect(
      consoleArgsToMessage([
        { type: 'string', value: 'status' },
        { type: 'number', value: 403 }
      ])
    ).toBe('status 403')
    expect(consoleArgsToMessage([])).toBe('')
    expect(consoleArgsToMessage(undefined)).toBe('')
  })
})

describe('CDP → draft mappers', () => {
  it('maps a console.error call with a stack frame', () => {
    const draft = draftFromConsoleApi({
      type: 'error',
      args: [{ type: 'string', value: 'CORS blocked' }],
      stackTrace: { callFrames: [{ url: 'https://x/app.js', lineNumber: 40 }] }
    })
    expect(draft).toEqual({
      level: 'error',
      message: 'CORS blocked',
      source: 'console',
      url: 'https://x/app.js',
      lineNumber: 41 // 0-based CDP → 1-based
    })
  })

  it('maps a browser network log entry (the bare 403 line)', () => {
    const draft = draftFromLogEntry({
      entry: {
        source: 'network',
        level: 'error',
        text: 'Failed to load resource: the server responded with a status of 403 (Forbidden)',
        url: 'https://auth.darty.com/am/json/.../authenticate'
      }
    })
    expect(draft.level).toBe('error')
    expect(draft.source).toBe('network')
    expect(draft.message).toContain('403')
    expect(draft.url).toContain('darty')
    expect('lineNumber' in draft).toBe(false)
  })

  it('lifts a CORS block to source=security even when Chromium tags it otherwise', () => {
    const draft = draftFromLogEntry({
      entry: {
        source: 'javascript', // NOT 'security' — how Chromium actually reports it
        level: 'error',
        text: "Access to fetch at 'https://api.x/' from origin 'https://x' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource."
      }
    })
    expect(draft.source).toBe('security')
  })

  it('lifts CSP and mixed-content lines to security too', () => {
    expect(
      draftFromLogEntry({ entry: { text: 'Refused to load … Content Security Policy directive' } })
        .source
    ).toBe('security')
    expect(
      draftFromLogEntry({ entry: { text: 'Mixed Content: The page was loaded over HTTPS …' } })
        .source
    ).toBe('security')
  })

  it('leaves a plain network line as network (no false security match)', () => {
    expect(draftFromLogEntry({ entry: { source: 'network', text: 'Failed to load: 403' } }).source).toBe(
      'network'
    )
  })

  it('maps an uncaught exception, preferring the stack description', () => {
    const draft = draftFromException({
      exceptionDetails: {
        text: 'Uncaught',
        exception: { description: 'TypeError: x is not a function\n  at y (a.js:2:3)' },
        url: 'https://x/a.js',
        lineNumber: 1
      }
    })
    expect(draft.level).toBe('error')
    expect(draft.source).toBe('exception')
    expect(draft.message).toContain('TypeError')
    expect(draft.lineNumber).toBe(2)
  })

  it('routes by method and ignores unrelated CDP messages', () => {
    expect(draftFromCdpMessage('Runtime.consoleAPICalled', { type: 'log', args: [] })?.source).toBe(
      'console'
    )
    expect(draftFromCdpMessage('Log.entryAdded', { entry: { source: 'network' } })?.source).toBe(
      'network'
    )
    expect(draftFromCdpMessage('Runtime.exceptionThrown', {})?.source).toBe('exception')
    expect(draftFromCdpMessage('Network.requestWillBeSent', {})).toBeNull()
    expect(draftFromCdpMessage('Page.frameNavigated', {})).toBeNull()
  })
})

describe('PageConsoleStore', () => {
  it('records and reads back in order with monotonic seqs', () => {
    const s = new PageConsoleStore()
    s.record('t1', { level: 'info', message: 'a', source: 'console' })
    s.record('t1', { level: 'error', message: 'b', source: 'network' })
    const out = s.read('t1')
    expect(out.map((e) => e.message)).toEqual(['a', 'b'])
    expect(out[0].seq).toBe(1)
    expect(out[1].seq).toBe(2)
  })

  it('keeps buffers separate per tab and returns [] for unknown tabs', () => {
    const s = new PageConsoleStore()
    s.record('t1', { level: 'info', message: 'a', source: 'console' })
    expect(s.read('t2')).toEqual([])
  })

  it('caps to the buffer limit, dropping oldest', () => {
    const s = new PageConsoleStore(3)
    for (let i = 0; i < 5; i++)
      s.record('t', { level: 'info', message: `m${i}`, source: 'console' })
    expect(s.read('t').map((e) => e.message)).toEqual(['m2', 'm3', 'm4'])
  })

  it('filters by minLevel', () => {
    const s = new PageConsoleStore()
    s.record('t', { level: 'info', message: 'i', source: 'console' })
    s.record('t', { level: 'warning', message: 'w', source: 'console' })
    s.record('t', { level: 'error', message: 'e', source: 'network' })
    expect(s.read('t', { minLevel: 'warning' }).map((e) => e.message)).toEqual(['w', 'e'])
    expect(s.read('t', { minLevel: 'error' }).map((e) => e.message)).toEqual(['e'])
  })

  it('caps to the most recent N via limit', () => {
    const s = new PageConsoleStore()
    for (let i = 0; i < 4; i++)
      s.record('t', { level: 'info', message: `m${i}`, source: 'console' })
    expect(s.read('t', { limit: 2 }).map((e) => e.message)).toEqual(['m2', 'm3'])
  })

  it('supports incremental polling via sinceSeq', () => {
    const s = new PageConsoleStore()
    s.record('t', { level: 'info', message: 'a', source: 'console' })
    const second = s.record('t', { level: 'info', message: 'b', source: 'console' })
    expect(s.read('t', { sinceSeq: second.seq - 1 }).map((e) => e.message)).toEqual(['b'])
    expect(s.read('t', { sinceSeq: second.seq })).toEqual([])
  })

  it('drops and clears buffers', () => {
    const s = new PageConsoleStore()
    s.record('t', { level: 'info', message: 'a', source: 'console' })
    s.clear('t')
    expect(s.read('t')).toEqual([])
    s.record('t', { level: 'info', message: 'b', source: 'console' })
    s.drop('t')
    expect(s.read('t')).toEqual([])
  })
})
