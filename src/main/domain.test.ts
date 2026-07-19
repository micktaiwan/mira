import { describe, it, expect } from 'vitest'
import { registrableDomain, hostMatchesDomain } from './domain'

describe('registrableDomain', () => {
  it('keeps a bare two-label host', () => {
    expect(registrableDomain('example.com')).toBe('example.com')
  })

  it('collapses subdomains to the last two labels', () => {
    expect(registrableDomain('www.example.com')).toBe('example.com')
    expect(registrableDomain('a.b.c.example.com')).toBe('example.com')
  })

  it('lower-cases and strips a trailing dot', () => {
    expect(registrableDomain('WWW.Example.COM.')).toBe('example.com')
  })

  it('keeps a single-label host as-is', () => {
    expect(registrableDomain('localhost')).toBe('localhost')
  })

  it('keeps IPv4 and IPv6 literals whole', () => {
    expect(registrableDomain('127.0.0.1')).toBe('127.0.0.1')
    expect(registrableDomain('[::1]')).toBe('[::1]')
  })

  it('degrades an empty host to empty', () => {
    expect(registrableDomain('')).toBe('')
  })
})

describe('hostMatchesDomain', () => {
  it('matches the base itself', () => {
    expect(hostMatchesDomain('example.com', 'example.com')).toBe(true)
  })

  it('matches any subdomain', () => {
    expect(hostMatchesDomain('www.example.com', 'example.com')).toBe(true)
    expect(hostMatchesDomain('a.b.example.com', 'example.com')).toBe(true)
  })

  it('strips a leading cookie dot on either side', () => {
    expect(hostMatchesDomain('.www.example.com', 'example.com')).toBe(true)
    expect(hostMatchesDomain('www.example.com', '.example.com')).toBe(true)
  })

  it('rejects a different domain and a suffix look-alike', () => {
    expect(hostMatchesDomain('example.org', 'example.com')).toBe(false)
    expect(hostMatchesDomain('notexample.com', 'example.com')).toBe(false)
    expect(hostMatchesDomain('evilexample.com', 'example.com')).toBe(false)
  })

  it('rejects an empty host or base', () => {
    expect(hostMatchesDomain('', 'example.com')).toBe(false)
    expect(hostMatchesDomain('example.com', '')).toBe(false)
  })
})
