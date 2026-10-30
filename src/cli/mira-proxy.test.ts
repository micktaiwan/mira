import { describe, it, expect } from 'vitest'
import { buildProxyCall, formatProxy, parseArgs } from './mira-core.mjs'

const build = (argv: string[]): unknown => {
  const { positionals, flags } = parseArgs(argv)
  return buildProxyCall(positionals, flags, 'p1')
}

describe('buildProxyCall', () => {
  it('reads the live proxy with no value, optionally for another url', () => {
    expect(build(['proxy', '--profile', 'test'])).toEqual({
      request: { command: 'get-profile-proxy', params: { id: 'p1' } }
    })
    expect(build(['proxy', '--profile', 'test', '--url', 'https://example.com'])).toEqual({
      request: { command: 'get-profile-proxy', params: { id: 'p1', url: 'https://example.com' } }
    })
  })

  it('sets a proxy, or clears it with --clear (a boolean: it never eats a positional)', () => {
    expect(build(['proxy', '--profile', 'test', 'socks5://127.0.0.1:1080'])).toEqual({
      request: {
        command: 'set-profile-proxy',
        params: { id: 'p1', proxy: 'socks5://127.0.0.1:1080' }
      }
    })
    expect(build(['proxy', '--clear', '--profile', 'test'])).toEqual({
      request: { command: 'set-profile-proxy', params: { id: 'p1', proxy: null } }
    })
  })

  it('refuses ambiguous combinations', () => {
    expect(build(['proxy', '--profile', 't', '--clear', 'socks5://127.0.0.1:1080'])).toEqual({
      error: 'proxy: pass a proxy or --clear, not both'
    })
    expect(build(['proxy', '--profile', 't', 'socks5://a:1', 'socks5://b:2'])).toEqual({
      error: 'proxy takes at most one proxy (e.g. socks5://127.0.0.1:1080)'
    })
    expect(build(['proxy', '--profile', 't', '--clear', '--url', 'https://x.com'])).toEqual({
      error: 'proxy: --url only goes with a read (no proxy, no --clear)'
    })
  })
})

describe('formatProxy', () => {
  it('prints a read on one line', () => {
    expect(
      formatProxy({
        id: 'p1',
        proxy: 'socks5://127.0.0.1:1080',
        proxyInvalid: null,
        applied: 'socks5://127.0.0.1:1080',
        blocked: null,
        url: 'https://www.linkedin.com',
        resolved: 'SOCKS5 127.0.0.1:1080',
        webrtcPolicies: ['disable_non_proxied_udp', 'disable_non_proxied_udp']
      })
    ).toBe(
      'p1: proxy socks5://127.0.0.1:1080 | applied socks5://127.0.0.1:1080 | https://www.linkedin.com -> SOCKS5 127.0.0.1:1080 | webrtc disable_non_proxied_udp'
    )
    expect(
      formatProxy({
        id: 'p1',
        proxy: null,
        proxyInvalid: null,
        applied: 'none',
        blocked: null,
        url: 'https://www.linkedin.com',
        resolved: 'DIRECT',
        webrtcPolicies: []
      })
    ).toBe(
      'p1: proxy direct | applied none | https://www.linkedin.com -> DIRECT | webrtc no live page'
    )
  })

  it('says loudly when the profile is blocked', () => {
    expect(
      formatProxy({
        id: 'p1',
        proxy: null,
        proxyInvalid: 'socks5://x;DIRECT',
        applied: 'socks5://127.0.0.1:1',
        blocked:
          'profile p1 has an invalid proxy setting (socks5://x;DIRECT): set a valid one or clear it',
        url: 'https://www.linkedin.com',
        resolved: 'SOCKS5 127.0.0.1:1',
        webrtcPolicies: []
      })
    ).toBe(
      'p1: proxy INVALID (socks5://x;DIRECT) | applied socks5://127.0.0.1:1 | https://www.linkedin.com -> SOCKS5 127.0.0.1:1 | webrtc no live page\n' +
        'BLOCKED: profile p1 has an invalid proxy setting (socks5://x;DIRECT): set a valid one or clear it'
    )
  })

  it('prints a write as the stored setting', () => {
    expect(formatProxy({ id: 'p1', proxy: null })).toBe('p1: proxy direct')
  })
})
