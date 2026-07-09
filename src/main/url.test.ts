import { describe, it, expect } from 'vitest'
import { normalizeInput } from './url'

describe('normalizeInput', () => {
  it('passes through full https/http URLs untouched', () => {
    expect(normalizeInput('https://example.com')).toBe('https://example.com')
    expect(normalizeInput('http://example.com/path?q=1')).toBe('http://example.com/path?q=1')
  })

  it('passes through file: and about: URLs untouched', () => {
    expect(normalizeInput('about:blank')).toBe('about:blank')
    expect(normalizeInput('file:///Users/foo/bar.html')).toBe('file:///Users/foo/bar.html')
  })

  it('defaults a bare domain to https', () => {
    expect(normalizeInput('example.com')).toBe('https://example.com')
    expect(normalizeInput('example.com/path')).toBe('https://example.com/path')
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
