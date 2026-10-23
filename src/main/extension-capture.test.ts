import { describe, it, expect } from 'vitest'
import {
  TAB_CAPTURE_ARM_TTL_MS,
  armFrame,
  authorizeCaptureSender,
  consumeArmedFrame,
  desktopSourceTypes,
  extensionIdFromUrl,
  extensionMayCapture,
  pickDesktopSource
} from './extension-capture'

describe('desktopSourceTypes', () => {
  it("maps Chrome's source list to Electron's, dropping tab/audio", () => {
    expect(desktopSourceTypes(['screen', 'window', 'tab', 'audio'])).toEqual(['screen', 'window'])
    expect(desktopSourceTypes(['window'])).toEqual(['window'])
  })

  it('falls back to screen+window when nothing usable was asked', () => {
    expect(desktopSourceTypes([])).toEqual(['screen', 'window'])
    expect(desktopSourceTypes(['tab', 'audio'])).toEqual(['screen', 'window'])
  })
})

describe('pickDesktopSource', () => {
  it('prefers a screen source over windows', () => {
    const picked = pickDesktopSource([
      { id: 'window:123:0', name: 'Some window' },
      { id: 'screen:0:0', name: 'Entire Screen' }
    ])
    expect(picked?.id).toBe('screen:0:0')
  })

  it('falls back to the first window, and to null on nothing', () => {
    expect(pickDesktopSource([{ id: 'window:1:0', name: 'W' }])?.id).toBe('window:1:0')
    expect(pickDesktopSource([])).toBeNull()
  })
})

describe('tab-capture arming', () => {
  it('consumes an armed frame exactly once, within its TTL', () => {
    const pending = new Map<string, number>()
    armFrame(pending, '7:12', 1_000)
    expect(consumeArmedFrame(pending, '7:12', 1_000 + TAB_CAPTURE_ARM_TTL_MS)).toBe(true)
    // Single use.
    expect(consumeArmedFrame(pending, '7:12', 1_000)).toBe(false)
  })

  it('rejects an expired or unknown frame', () => {
    const pending = new Map<string, number>()
    armFrame(pending, '7:12', 1_000)
    expect(consumeArmedFrame(pending, '7:12', 2_000 + TAB_CAPTURE_ARM_TTL_MS)).toBe(false)
    expect(consumeArmedFrame(pending, '9:1', 1_000)).toBe(false)
  })
})

describe('capture sender authorization', () => {
  const ID = 'abcdefghijklmnopabcdefghijklmnop'
  const manifests: Record<string, unknown> = {
    [ID]: { manifest_version: 3, permissions: ['storage'] },
    tabcap: { manifest_version: 3, permissions: ['tabCapture'] },
    deskcap: { manifest_version: 2, permissions: ['desktopCapture', 'https://*/*'] }
  }
  const lookup = (id: string): unknown => manifests[id] ?? null

  it('reads the extension id from a chrome-extension:// sender URL', () => {
    expect(extensionIdFromUrl(`chrome-extension://${ID}/recorder.html?x=1`)).toBe(ID)
    expect(extensionIdFromUrl('https://example.com/')).toBeNull()
    expect(extensionIdFromUrl('chrome-extension://')).toBeNull()
    expect(extensionIdFromUrl(undefined)).toBeNull()
  })

  it('requires the matching manifest permission', () => {
    expect(extensionMayCapture({ permissions: ['tabCapture'] }, 'tabCapture')).toBe(true)
    expect(extensionMayCapture({ permissions: ['tabCapture'] }, 'desktopCapture')).toBe(false)
    expect(extensionMayCapture({ permissions: [] }, 'tabCapture')).toBe(false)
    expect(extensionMayCapture({}, 'tabCapture')).toBe(false)
    expect(extensionMayCapture(null, 'tabCapture')).toBe(false)
    // optional_permissions alone is not a grant.
    expect(extensionMayCapture({ optional_permissions: ['tabCapture'] }, 'tabCapture')).toBe(false)
  })

  it('refuses an extension page whose manifest lacks tabCapture', () => {
    expect(authorizeCaptureSender(`chrome-extension://${ID}/page.html`, lookup, 'tabCapture')).toBe(
      false
    )
    expect(
      authorizeCaptureSender(`chrome-extension://${ID}/page.html`, lookup, 'desktopCapture')
    ).toBe(false)
  })

  it('accepts an extension page that declares the matching permission', () => {
    expect(authorizeCaptureSender('chrome-extension://tabcap/r.html', lookup, 'tabCapture')).toBe(
      true
    )
    expect(
      authorizeCaptureSender('chrome-extension://deskcap/r.html', lookup, 'desktopCapture')
    ).toBe(true)
    expect(authorizeCaptureSender('chrome-extension://deskcap/r.html', lookup, 'tabCapture')).toBe(
      false
    )
  })

  it('refuses web pages and unknown extensions', () => {
    expect(authorizeCaptureSender('https://evil.example/', lookup, 'tabCapture')).toBe(false)
    expect(authorizeCaptureSender('chrome-extension://gone/x.html', lookup, 'tabCapture')).toBe(
      false
    )
    expect(authorizeCaptureSender(undefined, lookup, 'tabCapture')).toBe(false)
  })
})
