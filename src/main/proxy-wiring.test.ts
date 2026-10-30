// Wiring of the per-profile proxy guards OUTSIDE the profile session (third
// audit): the functions profiles.ts / extensions.ts / index.ts call, driven here
// with fake Electron objects (fetch, webContents, ipcMain, the updater clock).
import { describe, it, expect, vi } from 'vitest'
import {
  type FetchedImage,
  blockedPageMirror,
  faviconForChrome,
  guardWebStoreIpc,
  replaceSessionPages,
  storeUpdateTick,
  wireWebStoreGuard
} from './proxy-wiring'
import { blockedPageUrl, isBlockedPageUrl, isWebStoreUrl } from './profile-proxy'

const ICON = 'https://static.licdn.com/aero-v1/sc/h/favicon.ico'

function fakeFetch(
  body: Uint8Array,
  type = 'image/x-icon',
  ok = true
): ReturnType<typeof vi.fn<(url: string) => Promise<FetchedImage>>> {
  return vi.fn<(url: string) => Promise<FetchedImage>>(async () => ({
    ok,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? type : null) },
    arrayBuffer: async () =>
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
  }))
}

describe('faviconForChrome', () => {
  it('fetches a proxied profile icon through the PROFILE session and returns data:', async () => {
    const fetch = fakeFetch(new Uint8Array([1, 2, 3]))
    const out = await faviconForChrome(
      { wantsProxy: () => true, gate: () => null, fetch },
      'test',
      ICON
    )
    expect(fetch).toHaveBeenCalledWith(ICON)
    expect(out).toBe('data:image/x-icon;base64,AQID')
  })

  it('never fetches when the gate refuses, and drops non-images and oversized icons', async () => {
    const fetch = fakeFetch(new Uint8Array([1]))
    expect(
      await faviconForChrome({ wantsProxy: () => true, gate: () => 'blocked', fetch }, 't', ICON)
    ).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
    const html = fakeFetch(new Uint8Array([1]), 'text/html')
    expect(
      await faviconForChrome({ wantsProxy: () => true, gate: () => null, fetch: html }, 't', ICON)
    ).toBeNull()
    const big = fakeFetch(new Uint8Array(256 * 1024 + 1))
    expect(
      await faviconForChrome({ wantsProxy: () => true, gate: () => null, fetch: big }, 't', ICON)
    ).toBeNull()
  })

  it('leaves an unproxied profile untouched (no fetch, remote URL kept)', async () => {
    const fetch = fakeFetch(new Uint8Array([1]))
    expect(
      await faviconForChrome({ wantsProxy: () => false, gate: () => null, fetch }, 'p', ICON)
    ).toBe(ICON)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('storeUpdateTick (Mira Web Store updater)', () => {
  it('updates unproxied profiles and skips proxied ones, re-asked at every tick', () => {
    const update = vi.fn(async () => {})
    const state = { last: 0 }
    const entries: Array<[string, string]> = [
      ['ses-real', 'real'],
      ['ses-test', 'test']
    ]
    let proxied = new Set(['test'])
    const r1 = storeUpdateTick(
      state,
      10_000_000_000,
      'active',
      entries,
      (id) => !proxied.has(id),
      update
    )
    expect(r1).toEqual({ updated: ['real'], skipped: ['test'] })
    expect(update).toHaveBeenCalledWith('ses-real')
    expect(update).not.toHaveBeenCalledWith('ses-test')
    // Later, `real` becomes proxied too: it is skipped from then on.
    proxied = new Set(['test', 'real'])
    const r2 = storeUpdateTick(
      state,
      10_000_000_000 + 4 * 3600_000,
      'active',
      entries,
      (id) => !proxied.has(id),
      update
    )
    expect(r2).toEqual({ updated: [], skipped: ['real', 'test'] })
  })

  it('respects the idle state and the 3 h minimum interval', () => {
    const update = vi.fn(async () => {})
    const state = { last: 0 }
    expect(storeUpdateTick(state, 1e10, 'idle', [['s', 'p']], () => true, update)).toBeNull()
    storeUpdateTick(state, 1e10, 'active', [['s', 'p']], () => true, update)
    expect(
      storeUpdateTick(state, 1e10 + 3600_000, 'active', [['s', 'p']], () => true, update)
    ).toBeNull()
    expect(update).toHaveBeenCalledTimes(1)
  })
})

describe('blockedPageMirror (tab URL while the explanation page is shown)', () => {
  it('keeps the pending intended URL, or decodes it from the page (history back)', () => {
    const page = blockedPageUrl('why', 'https://www.linkedin.com/in/x')
    expect(blockedPageMirror(page, 'https://www.linkedin.com/feed/')).toBe(
      'https://www.linkedin.com/feed/'
    )
    // Going back in history to an explanation page: no pending entry any more.
    expect(blockedPageMirror(page, undefined)).toBe('https://www.linkedin.com/in/x')
    expect(blockedPageMirror('https://www.linkedin.com/', undefined)).toBeNull()
  })
})

describe('replaceSessionPages (HARD BLOCK)', () => {
  it('replaces every page and keeps each tab URL', () => {
    const loads: string[] = []
    const remembered: Record<string, string> = {}
    const already = blockedPageUrl('earlier', 'https://www.linkedin.com/jobs/')
    const pages = [
      {
        tabId: 't1',
        wc: {
          getURL: () => 'https://www.linkedin.com/feed/',
          loadURL: (u: string) => loads.push(u)
        }
      },
      { tabId: 't2', wc: { getURL: () => already, loadURL: (u: string) => loads.push(u) } },
      {
        tabId: null,
        wc: { getURL: () => 'https://popup.example/', loadURL: (u: string) => loads.push(u) }
      }
    ]
    replaceSessionPages(pages, 'hard block', (tabId, url) => (remembered[tabId] = url))
    expect(remembered).toEqual({
      t1: 'https://www.linkedin.com/feed/',
      t2: 'https://www.linkedin.com/jobs/'
    })
    expect(loads).toHaveLength(3)
    expect(loads.every(isBlockedPageUrl)).toBe(true)
    expect(blockedPageMirror(loads[0], undefined)).toBe('https://www.linkedin.com/feed/')
    expect(blockedPageMirror(loads[1], undefined)).toBe('https://www.linkedin.com/jobs/')
  })
})

describe('wireWebStoreGuard (navigations a page starts itself)', () => {
  interface FakeWc {
    handlers: Record<string, (...a: unknown[]) => void>
    loads: string[]
    wc: {
      on: (ev: string, fn: (...a: unknown[]) => void) => void
      stop: ReturnType<typeof vi.fn<() => void>>
      loadURL: (u: string) => number
    }
  }
  function fakeWc(): FakeWc {
    const handlers: Record<string, (...a: unknown[]) => void> = {}
    const loads: string[] = []
    return {
      handlers,
      loads,
      wc: {
        on: (ev: string, fn: (...a: unknown[]) => void) => {
          handlers[ev] = fn
        },
        stop: vi.fn<() => void>(),
        loadURL: (u: string) => loads.push(u)
      }
    }
  }
  const refuse = (url: string): string | null => (isWebStoreUrl(url) ? 'web store refused' : null)

  it('cancels will-navigate / will-redirect / will-frame-navigate to the Web Store', () => {
    const { wc, handlers } = fakeWc()
    wireWebStoreGuard(wc, refuse)
    for (const ev of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
      const e = { preventDefault: vi.fn(), url: 'https://chromewebstore.google.com/detail/x/abc' }
      handlers[ev](e, 'https://chromewebstore.google.com/detail/x/abc')
      expect(e.preventDefault, ev).toHaveBeenCalled()
      const ok = { preventDefault: vi.fn(), url: 'https://www.linkedin.com/' }
      handlers[ev](ok, 'https://www.linkedin.com/')
      expect(ok.preventDefault, ev).not.toHaveBeenCalled()
    }
    // The old store URL redirects to the new one: both refused.
    const old = { preventDefault: vi.fn(), url: 'https://chrome.google.com/webstore/detail/abc' }
    handlers['will-redirect'](old, 'https://chrome.google.com/webstore/detail/abc')
    expect(old.preventDefault).toHaveBeenCalled()
  })

  it('a main-frame Web Store navigation that started anyway (popup) is stopped and replaced', () => {
    const { wc, handlers, loads } = fakeWc()
    wireWebStoreGuard(wc, refuse)
    handlers['did-start-navigation']({
      url: 'https://chromewebstore.google.com/',
      isMainFrame: true
    })
    expect(wc.stop).toHaveBeenCalled()
    expect(loads).toHaveLength(1)
    expect(isBlockedPageUrl(loads[0])).toBe(true)
  })
})

describe('guardWebStoreIpc (the library install entry, decided at call time)', () => {
  it('refuses install channels for a refused sender, passes the rest through', async () => {
    const registered: Record<string, (...a: unknown[]) => unknown> = {}
    const ipc = { handle: (ch: string, fn: (...a: unknown[]) => unknown) => (registered[ch] = fn) }
    let proxied = false
    guardWebStoreIpc(ipc, () => (proxied ? 'proxied profile' : null))
    // The library registers its handlers AFTER the guard is in place.
    const begin = vi.fn(async () => ({ result: 'success' }))
    const status = vi.fn(async () => 'installable')
    ipc.handle('chromeWebstore.beginInstall', begin)
    ipc.handle('chromeWebstore.getExtensionStatus', status)
    expect(await registered['chromeWebstore.beginInstall']({}, { id: 'x' })).toEqual({
      result: 'success'
    })
    // The profile becomes proxied mid-session: refused from the next call on,
    // without the library's handler (and its icon / CRX fetch) ever running.
    proxied = true
    begin.mockClear()
    expect(await registered['chromeWebstore.beginInstall']({}, { id: 'x' })).toEqual({
      result: 'blocked_by_policy'
    })
    expect(begin).not.toHaveBeenCalled()
    expect(await registered['chromeWebstore.getExtensionStatus']({}, 'x')).toBe('installable')
  })
})
