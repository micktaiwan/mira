import { describe, it, expect, vi } from 'vitest'
import { WINDOW_OPEN_SHIM_SOURCE } from './window-open-shim'

// The source reads a free `window`; pass a fake one in, as the stealth test does.
function runShim(win: Record<string, unknown>): void {
  new Function('window', WINDOW_OPEN_SHIM_SOURCE)(win)
}

type Stub = {
  closed: boolean
  close: () => void
  focus: () => void
  postMessage: () => void
}

describe('WINDOW_OPEN_SHIM_SOURCE', () => {
  it('substitutes a stub when the native open returns null (the Mira tab path)', () => {
    const native = vi.fn(() => null)
    const win: Record<string, unknown> = { open: native }
    runShim(win)
    const opened = (win.open as (u: string) => Stub)('https://example.com')
    expect(native).toHaveBeenCalledWith('https://example.com')
    expect(opened).toBeTruthy()
    expect(opened.closed).toBe(false)
    expect(typeof opened.focus).toBe('function')
    expect(typeof opened.postMessage).toBe('function')
  })

  it('marks the stub closed after close(), so pollers terminate', () => {
    const win: Record<string, unknown> = { open: () => null }
    runShim(win)
    const opened = (win.open as (u: string) => Stub)('https://example.com')
    opened.close()
    expect(opened.closed).toBe(true)
  })

  it('passes a real popup handle through untouched (OAuth window.opener survives)', () => {
    const real = { closed: false, opener: {} }
    const win: Record<string, unknown> = { open: () => real }
    runShim(win)
    expect((win.open as (u: string) => unknown)('https://accounts.google.com')).toBe(real)
  })

  it('forwards every argument to the native open', () => {
    const native = vi.fn(() => null)
    const win: Record<string, unknown> = { open: native }
    runShim(win)
    ;(win.open as (u: string, n: string, f: string) => unknown)('u', '_blank', 'width=520')
    expect(native).toHaveBeenCalledWith('u', '_blank', 'width=520')
  })

  it('is idempotent: re-injection on every navigation does not stack wrappers', () => {
    const native = vi.fn(() => null)
    const win: Record<string, unknown> = { open: native }
    runShim(win)
    const first = win.open
    runShim(win)
    runShim(win)
    expect(win.open).toBe(first)
  })

  it('still reads as a native function (String(window.open)), so it is not a new tell', () => {
    const win: Record<string, unknown> = {
      open: function open() {
        return null
      }
    }
    runShim(win)
    expect(String(win.open)).toContain('[native code]')
  })

  it('warns instead of failing silently when the page reads document/location on the stub', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const win: Record<string, unknown> = { open: () => null }
    runShim(win)
    const opened = (win.open as (u: string) => { document?: unknown })('')
    expect(opened.document).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not reachable'))
    warn.mockRestore()
  })

  it('never throws when there is no open to wrap', () => {
    const win: Record<string, unknown> = {}
    expect(() => runShim(win)).not.toThrow()
    expect(win.open).toBeUndefined()
  })
})
