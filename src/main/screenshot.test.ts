import { describe, it, expect } from 'vitest'
import {
  parseScreenshotParams,
  resolveScreenshotPath,
  screenshotFileName,
  clampCaptureSize,
  MAX_CAPTURE_PX
} from './screenshot'

describe('parseScreenshotParams', () => {
  it('defaults to the active tab, the default directory and the viewport', () => {
    expect(parseScreenshotParams(undefined)).toEqual({ fullPage: false })
    expect(parseScreenshotParams({})).toEqual({ fullPage: false })
  })

  it('keeps a trimmed tabId and path, and the fullPage flag', () => {
    expect(parseScreenshotParams({ tabId: ' t-1 ', path: ' /tmp/a.png ', fullPage: true })).toEqual(
      {
        tabId: 't-1',
        path: '/tmp/a.png',
        fullPage: true
      }
    )
  })

  it('refuses an empty or non-string tabId', () => {
    expect(() => parseScreenshotParams({ tabId: '' })).toThrow(/tabId/)
    expect(() => parseScreenshotParams({ tabId: 3 })).toThrow(/tabId/)
  })

  it('refuses an empty or non-string path', () => {
    expect(() => parseScreenshotParams({ path: '  ' })).toThrow(/path/)
    expect(() => parseScreenshotParams({ path: null })).toThrow(/path/)
  })

  it('refuses a non-boolean fullPage rather than coercing it', () => {
    // 'false' as a string would otherwise read as true and silently capture the
    // whole document — the one mistake a CLI passing strings would make.
    expect(() => parseScreenshotParams({ fullPage: 'true' })).toThrow(/fullPage/)
  })
})

describe('resolveScreenshotPath', () => {
  const at = new Date('2026-08-11T09:30:05')
  const dir = '/data/screenshots'

  it('names the file after the moment when no path is given', () => {
    expect(resolveScreenshotPath(undefined, { dir, at })).toBe(
      '/data/screenshots/shot-2026-08-11T09-30-05.png'
    )
    expect(resolveScreenshotPath('', { dir, at })).toBe(
      '/data/screenshots/shot-2026-08-11T09-30-05.png'
    )
  })

  it('keeps an absolute .png path as it is', () => {
    expect(resolveScreenshotPath('/tmp/cgm.png', { dir, at })).toBe('/tmp/cgm.png')
    expect(resolveScreenshotPath('/tmp/CGM.PNG', { dir, at })).toBe('/tmp/CGM.PNG')
  })

  it('appends .png when the name has no extension', () => {
    expect(resolveScreenshotPath('/tmp/cgm', { dir, at })).toBe('/tmp/cgm.png')
  })

  it('does not mistake a dot in a directory for an extension', () => {
    expect(resolveScreenshotPath('/tmp/v1.2/shot', { dir, at })).toBe('/tmp/v1.2/shot.png')
  })

  it('refuses another extension rather than writing PNG bytes under it', () => {
    expect(() => resolveScreenshotPath('/tmp/cgm.jpg', { dir, at })).toThrow(/\.png/)
  })

  it('refuses a relative path — Mira’s cwd is not the caller’s', () => {
    expect(() => resolveScreenshotPath('shot.png', { dir, at })).toThrow(/absolute/)
    expect(() => resolveScreenshotPath('./shot.png', { dir, at })).toThrow(/absolute/)
  })
})

describe('screenshotFileName', () => {
  it('sorts by name because it leads with the timestamp', () => {
    const early = screenshotFileName(new Date('2026-08-11T09:00:00'))
    const late = screenshotFileName(new Date('2026-08-11T10:00:00'))
    expect([late, early].sort()).toEqual([early, late])
  })
})

describe('clampCaptureSize', () => {
  it('leaves an ordinary page alone', () => {
    expect(clampCaptureSize({ width: 1280, height: 4200 })).toEqual({
      width: 1280,
      height: 4200,
      clamped: false
    })
  })

  it('rounds a fractional size up', () => {
    expect(clampCaptureSize({ width: 1279.5, height: 800.2 })).toEqual({
      width: 1280,
      height: 801,
      clamped: false
    })
  })

  it('caps an endless page and says so', () => {
    const size = clampCaptureSize({ width: 1280, height: 90_000 })
    expect(size.height).toBe(MAX_CAPTURE_PX)
    expect(size.clamped).toBe(true)
  })

  it('never returns a zero dimension', () => {
    expect(clampCaptureSize({ width: 0, height: 0 })).toEqual({
      width: 1,
      height: 1,
      clamped: false
    })
  })
})
