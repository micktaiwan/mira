import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'
import { fileUrlFor } from './open'

describe('fileUrlFor', () => {
  it('turns an absolute path into a file:// URL', () => {
    expect(fileUrlFor('/Users/me/page.html')).toBe('file:///Users/me/page.html')
  })

  it('percent-encodes spaces and non-ASCII so the loader gets a valid URL', () => {
    expect(fileUrlFor('/tmp/my page.html')).toBe('file:///tmp/my%20page.html')
    expect(fileUrlFor('/tmp/café.html')).toBe('file:///tmp/caf%C3%A9.html')
  })
})

describe('open-url', () => {
  it('hands the url to the default-browser opener and echoes it', () => {
    const { ctx, externalOpens } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('open-url', { url: 'https://example.com' }, ctx)).toEqual({
      ok: true,
      url: 'https://example.com'
    })
    expect(externalOpens).toEqual(['https://example.com'])
  })

  it('rejects a missing url', () => {
    const { ctx, externalOpens } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('open-url', {}, ctx)).toEqual({ ok: false, error: 'missing "url"' })
    expect(externalOpens).toEqual([])
  })

  it('rejects a blank or non-string url', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('open-url', { url: '   ' }, ctx)).toEqual({
      ok: false,
      error: 'missing "url"'
    })
    expect(registry.execute('open-url', { url: 42 }, ctx)).toEqual({
      ok: false,
      error: 'missing "url"'
    })
  })
})

describe('open-file', () => {
  it('opens a local file as a file:// URL', () => {
    const { ctx, externalOpens } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('open-file', { path: '/Users/me/page.html' }, ctx)).toEqual({
      ok: true,
      url: 'file:///Users/me/page.html'
    })
    expect(externalOpens).toEqual(['file:///Users/me/page.html'])
  })

  it('rejects a missing or non-string path', () => {
    const { ctx, externalOpens } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('open-file', {}, ctx)).toEqual({ ok: false, error: 'missing "path"' })
    expect(registry.execute('open-file', { path: '  ' }, ctx)).toEqual({
      ok: false,
      error: 'missing "path"'
    })
    expect(externalOpens).toEqual([])
  })
})
