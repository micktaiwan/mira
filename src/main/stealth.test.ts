import { describe, it, expect } from 'vitest'
import { CHROME_SHIM_SOURCE } from './stealth'

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
