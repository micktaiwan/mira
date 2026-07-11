import { describe, it, expect } from 'vitest'
import {
  buildErrorPage,
  describeLoadError,
  errorPageUrl,
  isMiraErrorUrl,
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

  it('escapes a hostile URL in markup and in the retry script', () => {
    const html = buildErrorPage({
      ...dnsError,
      url: 'https://a/<script>alert(1)</script>"onload'
    })
    expect(html).not.toContain('<script>alert(1)')
    // The retry target is a JSON string literal: quotes are escaped, so the
    // hostile URL cannot terminate the string and inject code.
    expect(html).toContain('location.href = "https://a/\\u003cscript')
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
