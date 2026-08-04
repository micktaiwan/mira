import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'
import { rootDomainUrl } from './root-domain'

describe('rootDomainUrl', () => {
  it('drops the subdomain, the path and the query', () => {
    expect(
      rootDomainUrl(
        'https://transverse.labanquepostale.fr/xo_/messages/message.html?param=0x13212070&v=4'
      )
    ).toBe('https://labanquepostale.fr/')
  })

  it('drops a www prefix', () => {
    expect(rootDomainUrl('https://www.example.com/a/b#c')).toBe('https://example.com/')
  })

  it('keeps a country public suffix intact', () => {
    expect(rootDomainUrl('https://www.bbc.co.uk/news')).toBe('https://bbc.co.uk/')
  })

  it('keeps the scheme and the port of the page', () => {
    expect(rootDomainUrl('http://intranet.corp.test/page')).toBe('http://corp.test/')
    expect(rootDomainUrl('http://localhost:5173/app')).toBe('http://localhost:5173/')
  })

  it('returns the origin unchanged for an IP literal', () => {
    expect(rootDomainUrl('http://192.168.1.10/admin')).toBe('http://192.168.1.10/')
  })

  it('refuses non-http(s) and unparseable urls', () => {
    expect(rootDomainUrl('about:blank')).toBeNull()
    expect(rootDomainUrl('file:///Users/me/index.html')).toBeNull()
    expect(rootDomainUrl('chrome-extension://abc/options.html')).toBeNull()
    expect(rootDomainUrl('not a url')).toBeNull()
  })
})

describe('go-root-domain', () => {
  it('loads the site root of the active tab', () => {
    const { ctx, loaded } = makeContext()
    const registry = createCommandRegistry()
    registry.execute(
      'new-tab',
      { url: 'https://transverse.labanquepostale.fr/xo_/messages/message.html?param=0x13212070' },
      ctx
    )
    expect(registry.execute('go-root-domain', {}, ctx)).toEqual({
      ok: true,
      url: 'https://labanquepostale.fr/',
      unchanged: false
    })
    expect(loaded).toEqual(['https://labanquepostale.fr/'])
  })

  it('does not reload when the page already IS the root', () => {
    const { ctx, loaded } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('new-tab', { url: 'https://labanquepostale.fr/' }, ctx)
    expect(registry.execute('go-root-domain', {}, ctx)).toEqual({
      ok: true,
      url: 'https://labanquepostale.fr/',
      unchanged: true
    })
    expect(loaded).toEqual([])
  })

  it('refuses a page with no root domain to go to', () => {
    const { ctx, loaded } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('new-tab', { url: 'about:blank' }, ctx)
    expect(registry.execute('go-root-domain', {}, ctx)).toEqual({
      ok: false,
      error: 'no root domain for: about:blank'
    })
    expect(loaded).toEqual([])
  })

  it('refuses the Settings tab (chrome, not a page)', () => {
    const { ctx, loaded } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('open-settings', {}, ctx)
    expect(registry.execute('go-root-domain', {}, ctx)).toEqual({
      ok: false,
      error: 'no active web page'
    })
    expect(loaded).toEqual([])
  })
})
