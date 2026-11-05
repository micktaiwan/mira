import { describe, expect, it, vi } from 'vitest'
import {
  armFreezeProbe,
  framesFromPause,
  loadEventFrom,
  runFreezeProbe,
  snippetAround,
  summarizeStacks,
  type ProbeDebugger
} from './freeze-probe'

type Listener = (e: unknown, method: string, params: unknown) => void

/** A debugger whose page answers according to `frozen`: evaluate and enable never
 * settle when frozen, but pause is delivered by interrupt, as in Chromium. */
function fakeDebugger(opts: { frozen?: boolean; pauses?: boolean } = {}): {
  dbg: ProbeDebugger
  opts: { frozen?: boolean; pauses?: boolean }
  sent: string[]
  emit: (method: string, params: unknown) => void
} {
  const listeners = new Set<Listener>()
  const sent: string[] = []
  const emit = (method: string, params: unknown): void => {
    for (const l of [...listeners]) l(null, method, params)
  }
  const dbg: ProbeDebugger = {
    isAttached: () => true,
    attach: () => {},
    on: (_e, l) => listeners.add(l),
    removeListener: (_e, l) => listeners.delete(l as unknown as Listener),
    sendCommand: (method) => {
      sent.push(method)
      if (method === 'Debugger.pause') {
        if (opts.pauses !== false) {
          emit('Debugger.paused', {
            callFrames: [
              {
                functionName: 'spin',
                url: '',
                location: { scriptId: '7', lineNumber: 0, columnNumber: 3 }
              }
            ]
          })
        }
        return Promise.resolve({})
      }
      if (method === 'Debugger.getScriptSource') {
        return Promise.resolve({ scriptSource: 'abcdef' })
      }
      if (
        opts.frozen &&
        !['Debugger.resume', 'Debugger.disable', 'Runtime.terminateExecution'].includes(method)
      ) {
        return new Promise(() => {})
      }
      return Promise.resolve({})
    }
  }
  return { dbg, opts, sent, emit }
}

describe('framesFromPause', () => {
  it('reads the frames and falls back on the url of the parsed script', () => {
    const frames = framesFromPause(
      {
        callFrames: [
          { functionName: '', url: '', location: { scriptId: '7', lineNumber: 2, columnNumber: 9 } }
        ]
      },
      new Map([['7', 'https://x.test/a.js']])
    )
    expect(frames).toEqual([
      { functionName: '(anonymous)', url: 'https://x.test/a.js', line: 2, column: 9 }
    ])
  })

  it('returns nothing on a malformed payload', () => {
    expect(framesFromPause({}, new Map())).toEqual([])
  })
})

describe('summarizeStacks', () => {
  it('groups identical stacks, most frequent first', () => {
    const a = { functionName: 'a', url: 'u', line: 1, column: 1 }
    const b = { functionName: 'b', url: 'u', line: 2, column: 2 }
    expect(summarizeStacks([[a], [b], [b]])).toEqual([
      { count: 2, frames: [b] },
      { count: 1, frames: [a] }
    ])
  })
})

describe('snippetAround', () => {
  it('marks the position on its line', () => {
    expect(snippetAround('first\nabcdef', 1, 3)).toBe('abc⟦HERE⟧def')
  })
})

describe('loadEventFrom', () => {
  it('keeps scripts and requests, drops data urls and unknown messages', () => {
    expect(loadEventFrom('Debugger.scriptParsed', { url: 'https://a/b.js' }, 5)).toEqual({
      atMs: 5,
      kind: 'script',
      url: 'https://a/b.js'
    })
    expect(loadEventFrom('Network.requestWillBeSent', { request: { url: 'data:x' } }, 5)).toBeNull()
    expect(loadEventFrom('Page.loadEventFired', {}, 5)).toBeNull()
  })

  it('carries the status of a response and the reason of a failure', () => {
    expect(
      loadEventFrom('Network.responseReceived', { response: { url: 'https://a', status: 403 } }, 1)
    ).toEqual({ atMs: 1, kind: 'response', url: 'https://a', detail: '403' })
    expect(
      loadEventFrom('Network.loadingFailed', { requestId: 'r', errorText: 'blocked' }, 1)
    ).toEqual({ atMs: 1, kind: 'failed', url: 'r', detail: 'blocked' })
  })
})

describe('runFreezeProbe', () => {
  it('says a frozen page that was not armed has no stack, and why', async () => {
    const { dbg, sent } = fakeDebugger({ frozen: true })
    const r = await runFreezeProbe(dbg, { heartbeatMs: 5 })
    expect(r.responsive).toBe(false)
    expect(r.armed).toBe(false)
    expect(r.stacks).toEqual([])
    expect(r.note).toMatch(/not armed/)
    expect(sent).not.toContain('Debugger.pause')
  })

  it('names the code holding an armed frozen page and resumes after each sample', async () => {
    const { dbg, opts, sent, emit } = fakeDebugger()
    await armFreezeProbe(dbg, () => 100)
    emit('Debugger.scriptParsed', { scriptId: '7', url: 'https://x.test/loop.js' })
    opts.frozen = true
    const r = await runFreezeProbe(dbg, { samples: 3, pauseMs: 20, heartbeatMs: 5 })
    expect(r.armed).toBe(true)
    expect(r.samplesTaken).toBe(3)
    expect(r.stacks).toHaveLength(1)
    expect(r.stacks[0].count).toBe(3)
    expect(r.stacks[0].frames[0]).toMatchObject({ functionName: 'spin', url: 'https://x.test/loop.js' })
    expect(r.snippet).toBe('abc⟦HERE⟧def')
    expect(sent.filter((m) => m === 'Debugger.resume')).toHaveLength(3)
    expect(r.timeline).toEqual([{ atMs: 0, kind: 'script', url: 'https://x.test/loop.js' }])
  })

  it('never pauses a page that answers', async () => {
    const { dbg, sent } = fakeDebugger()
    await armFreezeProbe(dbg)
    const r = await runFreezeProbe(dbg, { pauseMs: 5 })
    expect(r.responsive).toBe(true)
    expect(r.samplesTaken).toBe(0)
    expect(r.note).toMatch(/nothing to sample/)
    expect(sent).not.toContain('Debugger.pause')
  })

  it('clears a pause that never arrived, so the next script cannot stop on it', async () => {
    const { dbg, opts, sent } = fakeDebugger({ pauses: false })
    await armFreezeProbe(dbg)
    opts.frozen = true
    const r = await runFreezeProbe(dbg, { pauseMs: 5, heartbeatMs: 5 })
    expect(r.note).toMatch(/no pause arrived/)
    expect(sent).toContain('Debugger.disable')
  })

  it('does not hang on a resume that never answers', async () => {
    const { dbg, opts } = fakeDebugger()
    await armFreezeProbe(dbg)
    opts.frozen = true
    const real = dbg.sendCommand
    dbg.sendCommand = (m, a) => (m === 'Debugger.resume' ? new Promise(() => {}) : real(m, a))
    const r = await runFreezeProbe(dbg, { samples: 1, pauseMs: 5, heartbeatMs: 5 })
    expect(r.samplesTaken).toBe(1)
  })

  it('aborts the running script on request', async () => {
    const { dbg, sent } = fakeDebugger({ frozen: true })
    const r = await runFreezeProbe(dbg, { terminate: true, heartbeatMs: 5, pauseMs: 20 })
    expect(r.terminated).toBe(true)
    expect(sent).toContain('Runtime.terminateExecution')
  })
})

describe('armFreezeProbe', () => {
  it('is idempotent', async () => {
    const { dbg, sent } = fakeDebugger()
    expect(await armFreezeProbe(dbg)).toEqual({ armed: true, alreadyArmed: false })
    expect(await armFreezeProbe(dbg)).toEqual({ armed: true, alreadyArmed: true })
    expect(sent.filter((m) => m === 'Debugger.enable')).toHaveLength(1)
  })

  it('fails loudly when the page no longer answers', async () => {
    const { dbg } = fakeDebugger({ frozen: true })
    await expect(armFreezeProbe(dbg)).rejects.toThrow(/Debugger.enable timed out/)
  })

  it('leaves no listener and no enabled domain behind when arming fails', async () => {
    const { dbg, sent } = fakeDebugger({ frozen: true })
    const removed = vi.spyOn(dbg, 'removeListener')
    await expect(armFreezeProbe(dbg)).rejects.toThrow()
    expect(removed).toHaveBeenCalledTimes(1)
    expect(sent).toContain('Debugger.disable')
  })
})
