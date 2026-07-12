import { describe, it, expect } from 'vitest'
import { CHROME_SHIM_SOURCE, interpretSwProbe, swProbeLogLine } from './stealth'

// Evaluate the injected source against a fake window and assert it restores the
// window.chrome surface a real Chrome exposes. The source reads a free `window`, so we
// pass one in via Function(window, source).
function runShim(win: Record<string, unknown>): void {
  new Function('window', CHROME_SHIM_SOURCE)(win)
}

describe('CHROME_SHIM_SOURCE', () => {
  it('populates an EMPTY window.chrome (Electron/Mira baseline) like real Chrome', () => {
    const win = { chrome: {} } as { chrome: Record<string, unknown> }
    runShim(win)
    expect(typeof win.chrome.csi).toBe('function')
    expect(typeof win.chrome.loadTimes).toBe('function')
    expect(typeof win.chrome.app).toBe('object')
    expect(typeof win.chrome.runtime).toBe('object')
  })

  it('creates window.chrome when it is missing entirely', () => {
    const win: Record<string, unknown> = {}
    runShim(win)
    expect(typeof win.chrome).toBe('object')
    expect(typeof (win.chrome as Record<string, unknown>).runtime).toBe('object')
  })

  it('loadTimes() returns a plausible Chrome shape', () => {
    const win = { chrome: {} } as { chrome: { loadTimes: () => Record<string, unknown> } }
    runShim(win)
    const t = win.chrome.loadTimes()
    expect(t).toHaveProperty('connectionInfo', 'h2')
    expect(t).toHaveProperty('npnNegotiatedProtocol', 'h2')
    expect(typeof t.requestTime).toBe('number')
  })

  it('runtime exposes the enum surface and no-op messaging (id undefined on a plain page)', () => {
    const win = { chrome: {} } as { chrome: { runtime: Record<string, unknown> } }
    runShim(win)
    const r = win.chrome.runtime
    expect(r.PlatformOs).toMatchObject({ MAC: 'mac' })
    expect(r.OnInstalledReason).toMatchObject({ INSTALL: 'install' })
    expect(r.id).toBeUndefined()
    expect(typeof r.connect).toBe('function')
    expect(typeof r.sendMessage).toBe('function')
  })

  it('does not overwrite an already-populated window.chrome', () => {
    const marker = (): string => 'real'
    const win = { chrome: { csi: marker } } as { chrome: { csi: () => string } }
    runShim(win)
    expect(win.chrome.csi).toBe(marker) // untouched
  })

  it('never throws even on a frozen window', () => {
    const win = Object.freeze({ chrome: Object.freeze({}) })
    expect(() => runShim(win as Record<string, unknown>)).not.toThrow()
  })
})

describe('interpretSwProbe', () => {
  it('reads a healthy provider (ok + count)', () => {
    expect(interpretSwProbe(JSON.stringify({ sw: 'ok', count: 2 }))).toEqual({
      kind: 'ok',
      count: 2
    })
  })

  it('reads the no-api case', () => {
    expect(interpretSwProbe(JSON.stringify({ sw: 'no-api' }))).toEqual({ kind: 'no-api' })
  })

  it('flags the WhatsApp-killer as invalid-state (by error name)', () => {
    const v = interpretSwProbe(
      JSON.stringify({
        sw: 'error',
        name: 'InvalidStateError',
        message:
          'Failed to get ServiceWorkerRegistration objects: The document is in an invalid state.'
      })
    )
    expect(v.kind).toBe('invalid-state')
  })

  it('flags invalid-state from the message even when the name is missing', () => {
    const v = interpretSwProbe(
      JSON.stringify({ sw: 'error', name: '', message: 'the document is in an INVALID STATE' })
    )
    expect(v.kind).toBe('invalid-state')
  })

  it('classifies an unrelated SW error as other-error, not invalid-state', () => {
    const v = interpretSwProbe(
      JSON.stringify({ sw: 'error', name: 'SecurityError', message: 'insecure' })
    )
    expect(v).toMatchObject({ kind: 'other-error' })
  })

  it('treats a synchronous throw as an error verdict', () => {
    expect(interpretSwProbe(JSON.stringify({ sw: 'throw', message: 'boom' })).kind).toBe(
      'other-error'
    )
  })

  it('is defensive: non-string and non-JSON inputs are unparseable, never throwing', () => {
    expect(interpretSwProbe(42).kind).toBe('unparseable')
    expect(interpretSwProbe('not json {').kind).toBe('unparseable')
    expect(interpretSwProbe(JSON.stringify({ sw: 'weird' })).kind).toBe('unparseable')
  })
})

describe('swProbeLogLine', () => {
  it('stays quiet on a healthy page (ok / no-api → null)', () => {
    expect(swProbeLogLine('https://x.com', { kind: 'ok', count: 1 })).toBeNull()
    expect(swProbeLogLine('https://x.com', { kind: 'no-api' })).toBeNull()
  })

  it('logs the invalid-state failure with the url and a WhatsApp hint', () => {
    const line = swProbeLogLine('https://web.whatsapp.com/', {
      kind: 'invalid-state',
      detail: 'InvalidStateError'
    })
    expect(line).toContain('https://web.whatsapp.com/')
    expect(line).toContain('UNAVAILABLE')
    expect(line).toMatch(/whatsapp/i)
  })

  it('logs other-error and unparseable verdicts too', () => {
    expect(
      swProbeLogLine('https://x.com', { kind: 'other-error', detail: 'SecurityError' })
    ).toContain('failed')
    expect(swProbeLogLine('https://x.com', { kind: 'unparseable', detail: 'junk' })).toContain(
      'unreadable'
    )
  })
})
