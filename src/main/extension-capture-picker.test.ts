import { describe, expect, it } from 'vitest'
import {
  escapeHtml,
  pickerKind,
  renderPickerHtml,
  type PickerSource
} from './extension-capture-picker'

describe('pickerKind', () => {
  it('classifies screen ids', () => {
    expect(pickerKind('screen:0:0')).toBe('screen')
    expect(pickerKind('screen:12:0')).toBe('screen')
  })

  it('classifies everything else as a window', () => {
    expect(pickerKind('window:1234:0')).toBe('window')
    expect(pickerKind('')).toBe('window')
  })
})

describe('escapeHtml', () => {
  it('escapes markup-significant characters', () => {
    expect(escapeHtml(`<b>"a" & 'b'</b>`)).toBe(
      '&lt;b&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/b&gt;'
    )
  })
})

const source = (over: Partial<PickerSource>): PickerSource => ({
  id: 'window:1:0',
  name: 'Untitled',
  kind: 'window',
  thumbnail: 'data:image/png;base64,AAAA',
  appIcon: null,
  ...over
})

describe('renderPickerHtml', () => {
  it('groups screens before windows and lists each source', () => {
    const html = renderPickerHtml([
      source({ id: 'window:1:0', name: 'My Doc', kind: 'window' }),
      source({ id: 'screen:0:0', name: 'Entire screen', kind: 'screen' })
    ])
    expect(html).toContain('Screens')
    expect(html).toContain('Windows')
    expect(html).toContain('Entire screen')
    expect(html).toContain('My Doc')
    // Screens group renders before the Windows group.
    expect(html.indexOf('Screens')).toBeLessThan(html.indexOf('Windows'))
  })

  it('wires each card to report its own id via the picker bridge', () => {
    const html = renderPickerHtml([source({ id: 'screen:7:0', kind: 'screen' })])
    expect(html).toContain(`miraPicker.choose('screen:7:0')`)
    // Cancel reports the empty string.
    expect(html).toContain(`miraPicker.choose('')`)
  })

  it('escapes source names to prevent markup injection', () => {
    const html = renderPickerHtml([source({ name: '<img onerror=x>' })])
    expect(html).not.toContain('<img onerror=x>')
    expect(html).toContain('&lt;img onerror=x&gt;')
  })

  it('embeds the thumbnail data URL, or a placeholder when absent', () => {
    const withThumb = renderPickerHtml([source({ thumbnail: 'data:image/png;base64,ZZ' })])
    expect(withThumb).toContain('src="data:image/png;base64,ZZ"')
    const noThumb = renderPickerHtml([source({ thumbnail: '' })])
    expect(noThumb).toContain('thumb-empty')
  })

  it('shows an empty-state message and no grid when there are no sources', () => {
    const html = renderPickerHtml([])
    expect(html).toContain('No screen or window is available')
    expect(html).not.toContain('class="grid"')
  })

  it('renders an app icon only when present', () => {
    const withIcon = renderPickerHtml([source({ appIcon: 'data:image/png;base64,IC' })])
    expect(withIcon).toContain('class="app-icon"')
    const withoutIcon = renderPickerHtml([source({ appIcon: null })])
    expect(withoutIcon).not.toContain('class="app-icon"')
  })
})
