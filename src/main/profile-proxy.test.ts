import { describe, it, expect } from 'vitest'
import { needsProxyApply, parseProxyInput, proxyConfigFor } from './profile-proxy'

describe('proxyConfigFor', () => {
  it('hands Chromium the proxy as the only rule, with the loopback bypass removed', () => {
    expect(proxyConfigFor('socks5://127.0.0.1:1080')).toEqual({
      mode: 'fixed_servers',
      proxyRules: 'socks5://127.0.0.1:1080',
      proxyBypassRules: '<-loopback>'
    })
  })

  it('goes direct once cleared', () => {
    expect(proxyConfigFor(null)).toEqual({ mode: 'direct' })
  })

  it('never passes a fallback list through', () => {
    expect(() => proxyConfigFor('socks5://127.0.0.1:1080,direct://')).toThrow('invalid proxy')
  })
})

describe('parseProxyInput', () => {
  it('trims and validates, and clears on null or empty', () => {
    expect(parseProxyInput('  socks5://127.0.0.1:1080 ')).toBe('socks5://127.0.0.1:1080')
    expect(parseProxyInput('')).toBeNull()
    expect(parseProxyInput('   ')).toBeNull()
    expect(parseProxyInput(null)).toBeNull()
  })

  it('refuses a bad type or a malformed proxy with the expected shape in the message', () => {
    expect(() => parseProxyInput(1080)).toThrow('"proxy" must be a string or null')
    expect(() => parseProxyInput('127.0.0.1:1080')).toThrow(
      'invalid proxy: 127.0.0.1:1080 (expected socks5|http|https://host:port)'
    )
  })
})

describe('needsProxyApply', () => {
  it('leaves a never-proxied session at Electron default', () => {
    expect(needsProxyApply(undefined, null)).toBe(false)
  })

  it('applies a first proxy, a change, and a clear; skips a repeat', () => {
    expect(needsProxyApply(undefined, 'socks5://127.0.0.1:1080')).toBe(true)
    expect(needsProxyApply('socks5://127.0.0.1:1080', 'socks5://127.0.0.1:1081')).toBe(true)
    expect(needsProxyApply('socks5://127.0.0.1:1080', null)).toBe(true)
    expect(needsProxyApply('socks5://127.0.0.1:1080', 'socks5://127.0.0.1:1080')).toBe(false)
    expect(needsProxyApply(null, null)).toBe(false)
  })
})
