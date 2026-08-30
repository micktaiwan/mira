import { describe, expect, it } from 'vitest'
import { containsPermissions, originPatternCovers, originsContained } from './extension-permissions'

/** Bitwarden's real declaration — the case this module exists for. */
const BITWARDEN_HOSTS = ['https://*/*', 'http://*/*']

describe('originPatternCovers', () => {
  it('covers a concrete site with the host wildcard (the bug)', () => {
    expect(originPatternCovers('https://*/*', 'https://clients.boursobank.com/*')).toBe(true)
  })

  it('still covers an exactly equal pattern, as the literal comparison did', () => {
    expect(originPatternCovers('https://example.com/*', 'https://example.com/*')).toBe(true)
  })

  it('does not let one scheme cover another', () => {
    expect(originPatternCovers('https://*/*', 'http://example.com/*')).toBe(false)
    expect(originPatternCovers('http://*/*', 'https://example.com/*')).toBe(false)
  })

  it('reads the scheme wildcard as http and https, both ways', () => {
    expect(originPatternCovers('*://*/*', 'https://example.com/*')).toBe(true)
    expect(originPatternCovers('*://*/*', 'ftp://example.com/*')).toBe(false)
    expect(originPatternCovers('*://*/*', '*://example.com/*')).toBe(true)
    // A single-scheme grant cannot answer for the pair the wildcard asks about.
    expect(originPatternCovers('https://*/*', '*://example.com/*')).toBe(false)
  })

  it('covers a subdomain tree from *.host, including the bare host', () => {
    expect(originPatternCovers('https://*.foo.com/*', 'https://a.foo.com/*')).toBe(true)
    expect(originPatternCovers('https://*.foo.com/*', 'https://foo.com/*')).toBe(true)
    expect(originPatternCovers('https://*.foo.com/*', 'https://a.b.foo.com/*')).toBe(true)
    expect(originPatternCovers('https://*.foo.com/*', 'https://barfoo.com/*')).toBe(false)
    expect(originPatternCovers('https://*.foo.com/*', 'https://bar.com/*')).toBe(false)
  })

  it('never lets a narrow grant answer for a broader request', () => {
    expect(originPatternCovers('https://example.com/*', 'https://*/*')).toBe(false)
    expect(originPatternCovers('https://foo.com/*', 'https://*.foo.com/*')).toBe(false)
    expect(originPatternCovers('https://example.com/*', '<all_urls>')).toBe(false)
  })

  it('treats <all_urls> as covering everything', () => {
    expect(originPatternCovers('<all_urls>', 'https://example.com/*')).toBe(true)
    expect(originPatternCovers('<all_urls>', '<all_urls>')).toBe(true)
  })

  it('compares paths conservatively: /* covers all, anything else must be exact', () => {
    expect(originPatternCovers('https://*/*', 'https://a.com/deep/page')).toBe(true)
    expect(originPatternCovers('https://a.com/app/*', 'https://a.com/app/*')).toBe(true)
    expect(originPatternCovers('https://a.com/app/*', 'https://a.com/other')).toBe(false)
  })

  it('returns false rather than throwing on a malformed pattern', () => {
    expect(originPatternCovers('not a pattern', 'https://a.com/*')).toBe(false)
    expect(originPatternCovers('https://a.com', 'https://a.com/*')).toBe(false)
    expect(originPatternCovers('https://*/*', 'https://a.com')).toBe(false)
    expect(originPatternCovers('https://a*.com/*', 'https://ab.com/*')).toBe(false)
    expect(originPatternCovers('://a.com/*', 'https://a.com/*')).toBe(false)
  })
})

describe('originsContained', () => {
  it('accepts an origin covered by any one of the granted patterns', () => {
    expect(originsContained(BITWARDEN_HOSTS, ['http://localhost/*'])).toBe(true)
    expect(originsContained(BITWARDEN_HOSTS, ['https://a.com/*', 'http://b.com/*'])).toBe(true)
  })

  it('refuses when one requested origin is uncovered', () => {
    expect(originsContained(BITWARDEN_HOSTS, ['https://a.com/*', 'ftp://b.com/*'])).toBe(false)
  })

  it('asks nothing of an empty request', () => {
    expect(originsContained([], [])).toBe(true)
  })

  it('grants nothing from an empty declaration', () => {
    expect(originsContained([], ['https://a.com/*'])).toBe(false)
  })
})

describe('containsPermissions', () => {
  const granted = { permissions: ['storage', 'tabs'], origins: BITWARDEN_HOSTS }

  it('answers the question Bitwarden asks before injecting a content script', () => {
    expect(containsPermissions(granted, { origins: ['https://clients.boursobank.com/*'] })).toBe(
      true
    )
  })

  it('compares API permissions by name', () => {
    expect(containsPermissions(granted, { permissions: ['storage'] })).toBe(true)
    expect(containsPermissions(granted, { permissions: ['storage', 'bookmarks'] })).toBe(false)
  })

  it('requires both halves when both are asked', () => {
    expect(
      containsPermissions(granted, { permissions: ['tabs'], origins: ['https://a.com/*'] })
    ).toBe(true)
    expect(
      containsPermissions(granted, { permissions: ['bookmarks'], origins: ['https://a.com/*'] })
    ).toBe(false)
  })

  it('treats an empty question as satisfied, as Chrome does', () => {
    expect(containsPermissions(granted, {})).toBe(true)
  })

  it('grants nothing when the extension is unknown to the lib', () => {
    expect(containsPermissions(undefined, { origins: ['https://a.com/*'] })).toBe(false)
    expect(containsPermissions(null, { permissions: ['storage'] })).toBe(false)
    expect(containsPermissions(undefined, {})).toBe(true)
  })
})
