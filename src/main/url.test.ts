import os from 'node:os'
import { describe, it, expect } from 'vitest'
import { normalizeInput, sameUrl, settingsSectionFor } from './url'

describe('settingsSectionFor', () => {
  it('maps chrome://extensions to the extensions section', () => {
    expect(settingsSectionFor('chrome://extensions')).toBe('extensions')
    expect(settingsSectionFor('chrome://extensions/')).toBe('extensions')
    expect(settingsSectionFor('  CHROME://Extensions  ')).toBe('extensions')
    expect(settingsSectionFor('mira://extensions')).toBe('extensions')
  })

  it('maps chrome://settings and mira://settings to the default section', () => {
    expect(settingsSectionFor('chrome://settings')).toBe('general')
    expect(settingsSectionFor('mira://settings')).toBe('general')
  })

  it('passes an explicit sub-section through', () => {
    expect(settingsSectionFor('chrome://settings/profiles')).toBe('profiles')
    expect(settingsSectionFor('mira://settings/extensions')).toBe('extensions')
  })

  it('returns null for regular web inputs and unknown internal pages', () => {
    expect(settingsSectionFor('example.com')).toBeNull()
    expect(settingsSectionFor('https://example.com')).toBeNull()
    expect(settingsSectionFor('chrome extensions')).toBeNull()
    expect(settingsSectionFor('chrome://history')).toBeNull()
    expect(settingsSectionFor('chrome-extension://abcdef/options.html')).toBeNull()
  })
})

describe('normalizeInput', () => {
  it('passes through full https/http URLs untouched', () => {
    expect(normalizeInput('https://example.com')).toBe('https://example.com')
    expect(normalizeInput('http://example.com/path?q=1')).toBe('http://example.com/path?q=1')
  })

  it('passes through file: and about: URLs untouched', () => {
    expect(normalizeInput('about:blank')).toBe('about:blank')
    expect(normalizeInput('file:///Users/foo/bar.html')).toBe('file:///Users/foo/bar.html')
  })

  it('passes through chrome-extension: URLs untouched (extension pages)', () => {
    expect(normalizeInput('chrome-extension://abcdef/options.html')).toBe(
      'chrome-extension://abcdef/options.html'
    )
  })

  it('defaults a bare domain to https', () => {
    expect(normalizeInput('example.com')).toBe('https://example.com')
    expect(normalizeInput('example.com/path')).toBe('https://example.com/path')
  })

  it('turns local filesystem paths into file:// URLs', () => {
    expect(normalizeInput('/Users/foo/bar.html')).toBe('file:///Users/foo/bar.html')
    expect(normalizeInput('~/projects/example/index.html')).toBe(
      `file://${os.homedir()}/projects/example/index.html`
    )
    expect(normalizeInput('~')).toBe(`file://${os.homedir()}`)
  })

  it('defaults localhost and 127.0.0.1 to http', () => {
    expect(normalizeInput('localhost:3000')).toBe('http://localhost:3000')
    expect(normalizeInput('127.0.0.1:8080/app')).toBe('http://127.0.0.1:8080/app')
  })

  it('treats free text as a search query', () => {
    expect(normalizeInput('hello world')).toBe('https://www.google.com/search?q=hello%20world')
    expect(normalizeInput('what is electron')).toBe(
      'https://www.google.com/search?q=what%20is%20electron'
    )
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeInput('  example.com  ')).toBe('https://example.com')
  })

  it('returns empty string for empty or whitespace-only input', () => {
    expect(normalizeInput('')).toBe('')
    expect(normalizeInput('   ')).toBe('')
  })
})

describe('sameUrl', () => {
  it('matches identical URLs', () => {
    expect(sameUrl('https://example.com/a?q=1', 'https://example.com/a?q=1')).toBe(true)
  })

  it('ignores the trailing slash a loaded page acquires on a bare origin', () => {
    expect(sameUrl('https://example.com', 'https://example.com/')).toBe(true)
    expect(sameUrl('https://a.com/path/', 'https://a.com/path')).toBe(true)
  })

  it('keeps different paths, queries and hashes distinct', () => {
    expect(sameUrl('https://a.com/x', 'https://a.com/y')).toBe(false)
    expect(sameUrl('https://a.com/?q=1', 'https://a.com/?q=2')).toBe(false)
    expect(sameUrl('https://a.com/#top', 'https://a.com/#bottom')).toBe(false)
  })

  it('is false for non-URL strings (a sleeping tab placeholder, empty)', () => {
    expect(sameUrl('home', 'https://a.com')).toBe(false)
    expect(sameUrl('', '')).toBe(true)
  })
})
