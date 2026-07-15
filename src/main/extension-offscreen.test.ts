import { describe, it, expect } from 'vitest'
import { decideOffscreenRequest, resolveOffscreenUrl } from './extension-offscreen'

const EXT = 'bnflmljpbmkjeahgjakmjdanmhldjhbk'

describe('resolveOffscreenUrl', () => {
  it('resolves a relative extension resource against the extension origin', () => {
    expect(resolveOffscreenUrl(EXT, 'offscreenDocument.html')).toBe(
      `chrome-extension://${EXT}/offscreenDocument.html`
    )
    expect(resolveOffscreenUrl(EXT, '/nested/page.html?x=1')).toBe(
      `chrome-extension://${EXT}/nested/page.html?x=1`
    )
  })

  it('accepts an absolute url of the SAME extension only', () => {
    expect(resolveOffscreenUrl(EXT, `chrome-extension://${EXT}/x.html`)).toBe(
      `chrome-extension://${EXT}/x.html`
    )
    expect(resolveOffscreenUrl(EXT, 'chrome-extension://otherextension/x.html')).toBeNull()
    expect(resolveOffscreenUrl(EXT, 'https://evil.example/x.html')).toBeNull()
    expect(resolveOffscreenUrl(EXT, 'file:///etc/passwd')).toBeNull()
  })

  it('rejects empty input', () => {
    expect(resolveOffscreenUrl(EXT, '')).toBeNull()
    expect(resolveOffscreenUrl('', 'x.html')).toBeNull()
  })
})

describe('decideOffscreenRequest', () => {
  it('creates when no document exists, resolving the url', () => {
    const decision = decideOffscreenRequest({ op: 'create', url: 'off.html' }, EXT, false)
    expect(decision).toEqual({ verdict: 'create', url: `chrome-extension://${EXT}/off.html` })
  })

  it('is idempotent on a second create (our host is invisible to the guards extensions use)', () => {
    expect(decideOffscreenRequest({ op: 'create', url: 'off.html' }, EXT, true)).toEqual({
      verdict: 'noop'
    })
  })

  it('refuses a create that escapes the extension origin', () => {
    const decision = decideOffscreenRequest(
      { op: 'create', url: 'https://evil.example/' },
      EXT,
      false
    )
    expect(decision).toEqual({ verdict: 'error', error: 'invalid offscreen document url' })
  })

  it('maps close/has, and errors on anything else', () => {
    expect(decideOffscreenRequest({ op: 'close' }, EXT, true)).toEqual({ verdict: 'close' })
    expect(decideOffscreenRequest({ op: 'has' }, EXT, false)).toEqual({ verdict: 'has' })
    expect(decideOffscreenRequest({ op: 'nope' }, EXT, false)).toMatchObject({ verdict: 'error' })
    expect(decideOffscreenRequest({}, EXT, false)).toMatchObject({ verdict: 'error' })
  })
})
