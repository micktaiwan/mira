import { describe, it, expect } from 'vitest'
import { decideWindowOpen, decideExtensionWindowOpen } from './window-open'

describe('decideWindowOpen', () => {
  it('routes a popup (new-window) to a real child window — OAuth/SSO opener survives', () => {
    expect(
      decideWindowOpen({
        url: 'https://accounts.google.com/o/oauth2/...',
        disposition: 'new-window'
      })
    ).toEqual({
      kind: 'popup'
    })
  })

  it('also treats new-popup as a popup', () => {
    expect(
      decideWindowOpen({ url: 'https://login.microsoftonline.com', disposition: 'new-popup' })
    ).toEqual({
      kind: 'popup'
    })
  })

  it('opens a foreground-tab (target=_blank) as a Mira tab', () => {
    expect(
      decideWindowOpen({ url: 'https://example.com/page', disposition: 'foreground-tab' })
    ).toEqual({ kind: 'tab', url: 'https://example.com/page', referrer: undefined })
  })

  it('opens a background-tab (Cmd+click) as a Mira tab', () => {
    expect(
      decideWindowOpen({ url: 'https://example.com/bg', disposition: 'background-tab' })
    ).toEqual({ kind: 'tab', url: 'https://example.com/bg', referrer: undefined })
  })

  it('defaults an unknown/absent disposition to a tab', () => {
    expect(decideWindowOpen({ url: 'https://example.com' })).toEqual({
      kind: 'tab',
      url: 'https://example.com',
      referrer: undefined
    })
  })

  it("carries the opener's referrer onto the tab — LinkedIn safety/go needs it", () => {
    expect(
      decideWindowOpen({
        url: 'https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fdeveloper.lemlist.com',
        disposition: 'foreground-tab',
        referrer: { url: 'https://www.linkedin.com/feed/update/urn:li:activity:123/' }
      })
    ).toEqual({
      kind: 'tab',
      url: 'https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fdeveloper.lemlist.com',
      referrer: 'https://www.linkedin.com/feed/update/urn:li:activity:123/'
    })
  })

  it('leaves referrer undefined when the opener had an empty one (rel=noreferrer)', () => {
    expect(
      decideWindowOpen({
        url: 'https://example.com/page',
        disposition: 'foreground-tab',
        referrer: { url: '' }
      })
    ).toEqual({ kind: 'tab', url: 'https://example.com/page', referrer: undefined })
  })

  it('does not attach a referrer to a popup (OAuth/SSO stays a real window)', () => {
    expect(
      decideWindowOpen({
        url: 'https://accounts.google.com/o/oauth2/...',
        disposition: 'new-window',
        referrer: { url: 'https://app.example.com/login' }
      })
    ).toEqual({ kind: 'popup' })
  })
})

describe('decideExtensionWindowOpen', () => {
  const popupUrl = 'chrome-extension://khnbclggeggefodgimdekejhipkeobnc/public/popup.html'

  it('routes an extension popup link (lemlist "Get started") to a Mira tab', () => {
    expect(
      decideExtensionWindowOpen(popupUrl, {
        url: 'https://www.linkedin.com/search/results/people/?company=lemlist',
        disposition: 'foreground-tab'
      })
    ).toEqual({
      kind: 'tab',
      url: 'https://www.linkedin.com/search/results/people/?company=lemlist',
      referrer: undefined
    })
  })

  it('keeps an OAuth popup opened from an extension page as a real window', () => {
    expect(
      decideExtensionWindowOpen(popupUrl, {
        url: 'https://accounts.google.com/o/oauth2/...',
        disposition: 'new-window'
      })
    ).toEqual({ kind: 'popup' })
  })

  it('ignores a non-extension opener (http tab keeps Electron default)', () => {
    expect(
      decideExtensionWindowOpen('https://example.com/page', {
        url: 'https://other.com',
        disposition: 'foreground-tab'
      })
    ).toEqual({ kind: 'ignore' })
  })

  it('ignores the Mira home page (data: URL) opener', () => {
    expect(
      decideExtensionWindowOpen('data:text/html,...', {
        url: 'https://other.com',
        disposition: 'foreground-tab'
      })
    ).toEqual({ kind: 'ignore' })
  })
})
