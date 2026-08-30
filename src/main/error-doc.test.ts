import { describe, it, expect } from 'vitest'
import {
  buildErrorPage,
  describeLoadError,
  errorPageUrl,
  isMiraErrorUrl,
  isRetryUrl,
  RETRY_URL,
  type LoadError
} from './error-doc'

const dnsError: LoadError = {
  url: 'https://x.xom/',
  errorCode: -105,
  errorDescription: 'ERR_NAME_NOT_RESOLVED'
}

describe('describeLoadError', () => {
  it('maps the common net error codes to specific headlines', () => {
    expect(describeLoadError(dnsError).headline).toBe("This site can't be reached")
    expect(describeLoadError({ ...dnsError, errorCode: -106 }).headline).toBe(
      'No internet connection'
    )
    expect(describeLoadError({ ...dnsError, errorCode: -102 }).headline).toBe('Connection refused')
    expect(describeLoadError({ ...dnsError, errorCode: -7 }).headline).toBe('Connection timed out')
    expect(describeLoadError({ ...dnsError, errorCode: -118 }).headline).toBe(
      'Connection timed out'
    )
  })

  it('groups certificate errors (-2xx) under a security headline', () => {
    expect(describeLoadError({ ...dnsError, errorCode: -201 }).headline).toBe(
      'Connection is not secure'
    )
  })

  it('falls back to a generic headline for unmapped codes', () => {
    expect(describeLoadError({ ...dnsError, errorCode: -2 }).headline).toBe(
      'This page failed to load'
    )
  })
})

describe('buildErrorPage', () => {
  it('shows the failed URL, the error name and the code', () => {
    const html = buildErrorPage(dnsError)
    expect(html).toContain('https://x.xom/')
    expect(html).toContain('ERR_NAME_NOT_RESOLVED')
    expect(html).toContain('(-105)')
  })

  it('escapes a hostile URL in markup, and never puts it in the retry script', () => {
    const html = buildErrorPage({
      ...dnsError,
      url: 'https://a/<script>alert(1)</script>"onload'
    })
    expect(html).not.toContain('<script>alert(1)')
    // Retry navigates to the fixed private URL, never to the failed one: main
    // holds the target, so a hostile URL never reaches the inline script at all.
    expect(html).toContain(`location.href = "${RETRY_URL}"`)
    expect(html).not.toContain('location.href = "https://a/')
  })

  it('retries through the private URL, not a direct navigation', () => {
    // A plain location.href to the failed URL is blocked by Chromium whenever
    // the target is file:// — the error page is a data: URL, and a data: origin
    // may not load a local resource. That is why Retry goes through main.
    const html = buildErrorPage({ ...dnsError, url: 'file:///Users/me/page.html' })
    expect(html).not.toContain('location.href = "file://')
    expect(html).toContain(RETRY_URL)
  })

  it('embeds the marker so the navigation is recognizable', () => {
    expect(isMiraErrorUrl(errorPageUrl(dnsError))).toBe(true)
  })
})

describe('isMiraErrorUrl', () => {
  it('rejects ordinary URLs, including data: URLs', () => {
    expect(isMiraErrorUrl('https://example.com')).toBe(false)
    expect(isMiraErrorUrl('data:text/html,hello')).toBe(false)
    expect(isMiraErrorUrl('')).toBe(false)
  })
})

describe('isRetryUrl', () => {
  it('matches only the exact retry action URL', () => {
    expect(isRetryUrl(RETRY_URL)).toBe(true)
    expect(isRetryUrl('https://example.com')).toBe(false)
    expect(isRetryUrl('mira-retry:something')).toBe(false)
    expect(isRetryUrl('')).toBe(false)
  })
})
