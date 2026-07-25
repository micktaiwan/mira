import { describe, expect, it } from 'vitest'
import {
  buildDownloadPage,
  describeDownloadState,
  downloadActionUrl,
  downloadPageUrl,
  isMiraDownloadUrl,
  parseDownloadActionUrl,
  type DownloadPageInfo
} from './download-doc'

function info(patch: Partial<DownloadPageInfo> = {}): DownloadPageInfo {
  return {
    id: 'dl-1',
    state: 'completed',
    filename: 'profile.mobileconfig',
    url: 'https://mdm.example.com/enroll/abc',
    savePath: '/Users/me/Downloads/profile.mobileconfig',
    bytes: 8151,
    ...patch
  }
}

describe('downloadActionUrl / parseDownloadActionUrl', () => {
  it('round-trips open and reveal actions', () => {
    const id = 'bc6b835e-3a10-401b-97a2-bc05708399cc'
    expect(parseDownloadActionUrl(downloadActionUrl('open', id))).toEqual({ action: 'open', id })
    expect(parseDownloadActionUrl(downloadActionUrl('reveal', id))).toEqual({
      action: 'reveal',
      id
    })
  })

  it('rejects anything that is not a mira-dl action URL', () => {
    expect(parseDownloadActionUrl('https://example.com')).toBeNull()
    expect(parseDownloadActionUrl('mira-dl:delete:abc')).toBeNull()
    expect(parseDownloadActionUrl('mira-dl:open:')).toBeNull()
    expect(parseDownloadActionUrl('mira-dl:open:abc:extra')).toBeNull()
    expect(parseDownloadActionUrl('')).toBeNull()
  })
})

describe('isMiraDownloadUrl', () => {
  it('recognizes the generated page URL and nothing else', () => {
    expect(isMiraDownloadUrl(downloadPageUrl(info()))).toBe(true)
    expect(isMiraDownloadUrl('https://example.com')).toBe(false)
    expect(isMiraDownloadUrl('')).toBe(false)
  })
})

describe('describeDownloadState', () => {
  it('phrases every state', () => {
    expect(describeDownloadState('progressing').headline).toBe('Downloading…')
    expect(describeDownloadState('completed').headline).toBe('File downloaded')
    expect(describeDownloadState('cancelled').headline).toBe('Download cancelled')
    expect(describeDownloadState('interrupted').headline).toBe('Download failed')
  })
})

describe('buildDownloadPage', () => {
  it('shows the filename, size and source URL', () => {
    const html = buildDownloadPage(info())
    expect(html).toContain('profile.mobileconfig')
    expect(html).toContain('8 KB')
    expect(html).toContain('https://mdm.example.com/enroll/abc')
  })

  it('offers Open / Reveal buttons only once completed', () => {
    const done = buildDownloadPage(info())
    expect(done).toContain('Open')
    expect(done).toContain('Reveal in Finder')
    expect(done).toContain(downloadActionUrl('open', 'dl-1'))
    expect(done).toContain(downloadActionUrl('reveal', 'dl-1'))
    const running = buildDownloadPage(info({ state: 'progressing' }))
    expect(running).not.toContain('Reveal in Finder')
    expect(running).not.toContain('mira-dl:')
  })

  it('titles the tab after the downloaded file', () => {
    expect(buildDownloadPage(info())).toContain('<title>Downloaded profile.mobileconfig</title>')
    expect(buildDownloadPage(info({ state: 'progressing' }))).toContain(
      '<title>Downloading…</title>'
    )
  })

  it('omits the size line when the byte count is unknown', () => {
    const html = buildDownloadPage(info({ bytes: 0 }))
    expect(html).not.toContain('class="size"')
  })

  it('escapes hostile filenames and URLs', () => {
    const html = buildDownloadPage(
      info({ filename: '<img src=x onerror=alert(1)>.zip', url: 'https://x.test/?q="><script>' })
    )
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('"><script>')
    expect(html).toContain('&lt;img src=x')
  })
})
