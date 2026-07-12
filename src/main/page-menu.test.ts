import { describe, it, expect } from 'vitest'
import { buildPageMenu, buildMediaItem, type PageContext } from './page-menu'

const base: PageContext = {
  linkURL: '',
  selectionText: '',
  isEditable: false,
  canGoBack: false,
  canGoForward: false,
  mediaType: 'none',
  srcURL: ''
}

describe('buildPageMenu', () => {
  it('always offers back / forward / reload, with history-driven enabled flags', () => {
    const items = buildPageMenu({ ...base, canGoBack: true, canGoForward: false })
    expect(items).toEqual([
      { type: 'command', command: 'back', label: 'Back', enabled: true },
      { type: 'command', command: 'forward', label: 'Forward', enabled: false },
      { type: 'command', command: 'reload', label: 'Reload', enabled: true }
    ])
  })

  it('adds an "open link in new tab" command when on a link', () => {
    const items = buildPageMenu({ ...base, linkURL: 'https://example.com' })
    expect(items).toContainEqual({
      type: 'command',
      command: 'new-tab',
      params: { url: 'https://example.com' },
      label: 'Open Link in New Tab',
      enabled: true
    })
  })

  it('offers the full clipboard set in an editable field', () => {
    const items = buildPageMenu({ ...base, isEditable: true })
    const roles = items.filter((i) => i.type === 'role').map((i) => i.type === 'role' && i.role)
    expect(roles).toEqual(['cut', 'copy', 'paste', 'selectAll'])
  })

  it('offers only Copy over a plain text selection (not editable)', () => {
    const items = buildPageMenu({ ...base, selectionText: 'hello' })
    const roles = items.filter((i) => i.type === 'role').map((i) => i.type === 'role' && i.role)
    expect(roles).toEqual(['copy'])
  })

  it('shows no clipboard items when there is neither a selection nor an editable field', () => {
    const items = buildPageMenu(base)
    expect(items.some((i) => i.type === 'role')).toBe(false)
    expect(items.some((i) => i.type === 'separator')).toBe(false)
  })

  it('adds a direct "Download Image" command over an image', () => {
    const items = buildPageMenu({ ...base, mediaType: 'image', srcURL: 'https://x.com/a.png' })
    expect(items).toContainEqual({
      type: 'command',
      command: 'download-media',
      params: { url: 'https://x.com/a.png' },
      label: 'Download Image',
      enabled: true
    })
  })

  it('routes a streamed (blob:) video to the yt-dlp download-stream item', () => {
    const items = buildPageMenu({ ...base, mediaType: 'video', srcURL: 'blob:https://x.com/abc' })
    expect(items).toContainEqual({ type: 'download-stream', label: 'Download Video' })
  })
})

describe('buildMediaItem', () => {
  it('downloads a plain-file video directly (not via yt-dlp)', () => {
    const item = buildMediaItem('video', 'https://x.com/clip.mp4')
    expect(item).toEqual({
      type: 'command',
      command: 'download-media',
      params: { url: 'https://x.com/clip.mp4' },
      label: 'Download Video',
      enabled: true
    })
  })

  it('routes a blob: or empty video src to yt-dlp (a stream has no file)', () => {
    expect(buildMediaItem('video', 'blob:x')).toEqual({
      type: 'download-stream',
      label: 'Download Video'
    })
    expect(buildMediaItem('video', '')).toEqual({
      type: 'download-stream',
      label: 'Download Video'
    })
  })

  it('downloads audio directly and ignores non-media', () => {
    expect(buildMediaItem('audio', 'https://x.com/a.mp3')).toMatchObject({
      command: 'download-media',
      label: 'Download Audio'
    })
    expect(buildMediaItem('none', '')).toBeNull()
    expect(buildMediaItem('image', '')).toBeNull()
  })
})
