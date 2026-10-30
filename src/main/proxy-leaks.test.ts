// Home-IP leaks OUTSIDE a proxied profile's own session (second proxy audit):
// what the chrome UI may load, the Chrome Web Store, yt-dlp, and the tab URL kept
// while the gate refuses a load. Each test here failed before its fix.
import { describe, it, expect } from 'vitest'
import {
  BLACKHOLE_PROXY,
  ProxyController,
  blockedPageUrl,
  chromeSafeImageUrl,
  isBlockedPageUrl,
  profileWantsProxy,
  webStoreOptionsFor,
  ytdlpProxyFor
} from './profile-proxy'
import { ytdlpArgs } from './ytdlp'

const PROXY = 'socks5://127.0.0.1:1080'
const P = 'persist:mira-test'

describe('1. the chrome UI never loads a remote resource of a proxied profile', () => {
  it('drops a remote favicon / thumbnail URL for a proxied or invalid-proxy profile', () => {
    expect(chromeSafeImageUrl(true, 'https://static.licdn.com/favicon.ico')).toBeNull()
    expect(chromeSafeImageUrl(true, 'http://x/y.png')).toBeNull()
    expect(chromeSafeImageUrl(true, '//cdn.example.com/a.png')).toBeNull()
    expect(chromeSafeImageUrl(true, 'blob:https://www.linkedin.com/1')).toBeNull()
    expect(chromeSafeImageUrl(true, null)).toBeNull()
  })

  it('keeps data: images (fetched through the profile session) and leaves other profiles alone', () => {
    expect(chromeSafeImageUrl(true, 'data:image/png;base64,AAAA')).toBe(
      'data:image/png;base64,AAAA'
    )
    expect(chromeSafeImageUrl(false, 'https://example.com/favicon.ico')).toBe(
      'https://example.com/favicon.ico'
    )
  })

  it('treats a stored invalid proxy as proxied', () => {
    expect(profileWantsProxy({ id: 'a', proxy: PROXY })).toBe(true)
    expect(profileWantsProxy({ id: 'a', proxyInvalid: 'x' })).toBe(true)
    expect(profileWantsProxy({ id: 'a' })).toBe(false)
  })
})

describe('2. the Chrome Web Store never runs for a proxied profile', () => {
  it('blocks every Web Store install (before the icon fetch) and never auto-updates', () => {
    // allowlist [] = every id is BLOCKED_BY_POLICY in the library's beginInstall,
    // which is checked before it fetches the icon with the main-process fetch.
    expect(webStoreOptionsFor(true)).toEqual({ autoUpdate: false, allowlist: [] })
    // The library's own updater is off for everyone: Mira runs its own, which
    // skips proxied profiles at every check.
    expect(webStoreOptionsFor(false)).toEqual({ autoUpdate: false })
  })

  it('the load gate refuses the Web Store pages in a proxied profile, even confirmed', async () => {
    const ctl = new ProxyController(async () => {})
    await ctl.ensure(P, PROXY)
    const profile = { id: 'test', proxy: PROXY }
    expect(ctl.gate(profile, P, 'https://www.linkedin.com/')).toBeNull()
    expect(ctl.gate(profile, P, 'https://chromewebstore.google.com/detail/x/abc')).toMatch(
      /Chrome Web Store/
    )
    // Not proxied: allowed.
    expect(ctl.gate({ id: 'plain' }, P, 'https://chromewebstore.google.com/')).toBeNull()
  })
})

describe('3. yt-dlp goes through the profile proxy, or does not run', () => {
  it('passes --proxy, with socks5h so yt-dlp resolves DNS on the proxy too', () => {
    const args = ytdlpArgs('https://x.com/a/status/1', '/tmp/out', 'socks5h://127.0.0.1:1080')
    expect(args[args.indexOf('--proxy') + 1]).toBe('socks5h://127.0.0.1:1080')
    expect(args.at(-1)).toBe('https://x.com/a/status/1')
    expect(ytdlpArgs('https://x.com/a/status/1', '/tmp/out')).not.toContain('--proxy')
  })

  it('never lets ffmpeg download the network for a proxied profile', () => {
    // yt-dlp hands m3u8 / live streams to ffmpeg, which ignores a SOCKS proxy
    // (yt_dlp/downloader/external.py FFmpegFD: only a warning) and connects directly.
    const args = ytdlpArgs('https://x.com/a/status/1', '/tmp/out', 'socks5h://127.0.0.1:1080')
    expect(args[args.indexOf('--downloader') + 1]).toBe('native')
    // Live streams always go to ffmpeg, even with --downloader native: refused.
    expect(args[args.indexOf('--match-filters') + 1]).toBe('!is_live')
    // Protocols only ffmpeg/rtmpdump fetch are filtered out of format selection.
    expect(args[args.indexOf('-f') + 1]).toBe(
      'bv*[protocol!*=rtmp][protocol!*=rtsp][protocol!*=mms]+ba[protocol!*=rtmp][protocol!*=rtsp][protocol!*=mms]/b[protocol!*=rtmp][protocol!*=rtsp][protocol!*=mms]'
    )
    // The ffmpeg SOCKS warning must stay visible.
    expect(args).not.toContain('--no-warnings')
    // An unproxied download is unchanged.
    const plain = ytdlpArgs('https://x.com/a/status/1', '/tmp/out')
    expect(plain).toContain('--no-warnings')
    expect(plain).not.toContain('--downloader')
  })

  it('maps the profile proxy for yt-dlp, refuses a blocked profile, nothing for others', async () => {
    const ctl = new ProxyController(async () => {})
    const url = 'https://x.com/a/status/1'
    const profile = { id: 'test', proxy: PROXY }
    // Not confirmed yet: refused.
    expect(ytdlpProxyFor(ctl, profile, P, url)).toEqual({
      error: expect.stringMatching(/not confirmed/)
    })
    await ctl.ensure(P, PROXY)
    expect(ytdlpProxyFor(ctl, profile, P, url)).toEqual({ proxy: 'socks5h://127.0.0.1:1080' })
    expect(ytdlpProxyFor(ctl, { id: 't', proxy: 'http://10.0.0.1:3128' }, undefined, url)).toEqual({
      error: expect.stringMatching(/not confirmed/)
    })
    expect(ytdlpProxyFor(ctl, { id: 'bad', proxyInvalid: 'x' }, P, url)).toEqual({
      error: expect.stringMatching(/invalid proxy setting/)
    })
    expect(ytdlpProxyFor(ctl, { id: 'plain' }, P, url)).toEqual({ proxy: null })
  })
})

describe('4. a refused load keeps the URL the user asked for', () => {
  it('the explanation page is recognisable and names the intended URL', () => {
    const page = blockedPageUrl('some reason', 'https://www.linkedin.com/in/someone')
    expect(isBlockedPageUrl(page)).toBe(true)
    expect(decodeURIComponent(page)).toContain('https://www.linkedin.com/in/someone')
    expect(isBlockedPageUrl('data:text/html,<p>other</p>')).toBe(false)
    expect(isBlockedPageUrl('https://www.linkedin.com/')).toBe(false)
  })

  it('the invalid-proxy reason names the URL that was refused', () => {
    const ctl = new ProxyController(async () => {})
    expect(ctl.gate({ id: 'test', proxyInvalid: 'bad' }, P, 'https://www.linkedin.com/feed')).toBe(
      'profile test has an invalid proxy setting (bad): refusing to load https://www.linkedin.com/feed; set a valid proxy or clear it'
    )
  })
})

describe('5. a session that cannot even be black-holed is hard-blocked, loudly', () => {
  it('reports the hard block and keeps the gate shut', async () => {
    const hard: string[] = []
    const ctl = new ProxyController(
      async (_p, config) => {
        if (config.mode === 'fixed_servers') throw new Error('setProxy failed')
      },
      () => {},
      (partition) => hard.push(partition)
    )
    await expect(ctl.ensure(P, PROXY)).rejects.toThrow('setProxy failed')
    expect(hard).toEqual([P])
    expect(ctl.isHardBlocked(P)).toBe(true)
    expect(ctl.applied(P)).toBeUndefined()
    expect(ctl.gate({ id: 'test', proxy: PROXY }, P, 'https://www.linkedin.com/')).toMatch(
      /hard-blocked/
    )
    void BLACKHOLE_PROXY
  })
})
