import { describe, it, expect } from 'vitest'
import { defaultSettings, normalizeSettings, withHomeUrl, DEFAULT_HOME_URL } from './settings-store'

describe('normalizeSettings', () => {
  it('keeps a valid homeUrl', () => {
    expect(normalizeSettings({ homeUrl: 'https://example.com' })).toEqual({
      homeUrl: 'https://example.com'
    })
  })

  it('trims a valid homeUrl', () => {
    expect(normalizeSettings({ homeUrl: '  https://example.com  ' })).toEqual({
      homeUrl: 'https://example.com'
    })
  })

  it('falls back to the default on a missing / empty / non-string homeUrl', () => {
    expect(normalizeSettings({})).toEqual(defaultSettings())
    expect(normalizeSettings({ homeUrl: '' })).toEqual({ homeUrl: DEFAULT_HOME_URL })
    expect(normalizeSettings({ homeUrl: '   ' })).toEqual({ homeUrl: DEFAULT_HOME_URL })
    expect(normalizeSettings({ homeUrl: 42 })).toEqual({ homeUrl: DEFAULT_HOME_URL })
  })

  it('degrades a bad/missing file to defaults', () => {
    expect(normalizeSettings(null)).toEqual(defaultSettings())
    expect(normalizeSettings('nope')).toEqual(defaultSettings())
    expect(normalizeSettings(undefined)).toEqual(defaultSettings())
  })
})

describe('withHomeUrl', () => {
  it('sets a trimmed home url', () => {
    expect(withHomeUrl({ homeUrl: 'a' }, '  https://b.com ')).toEqual({ homeUrl: 'https://b.com' })
  })

  it('rejects an empty value (home page can never be blanked)', () => {
    expect(withHomeUrl({ homeUrl: 'a' }, '   ')).toEqual({ homeUrl: 'a' })
    expect(withHomeUrl({ homeUrl: 'a' }, '')).toEqual({ homeUrl: 'a' })
  })
})
