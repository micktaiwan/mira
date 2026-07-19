import { describe, it, expect } from 'vitest'
import { buildAudioMenu } from './audio-menu'

describe('buildAudioMenu', () => {
  it('shows a disabled placeholder when nothing is audible', () => {
    expect(buildAudioMenu([])).toEqual([{ type: 'disabled', label: 'No tabs playing audio' }])
  })

  it('emits one select-tab item per audible tab, in order', () => {
    const items = buildAudioMenu([
      { id: 'a', title: 'YouTube', url: 'https://youtube.com' },
      { id: 'b', title: 'Spotify', url: 'https://open.spotify.com' }
    ])
    expect(items).toEqual([
      { type: 'command', command: 'select-tab', params: { id: 'a' }, label: 'YouTube' },
      { type: 'command', command: 'select-tab', params: { id: 'b' }, label: 'Spotify' }
    ])
  })

  it('falls back to the url, then a generic label, when the title is blank', () => {
    const items = buildAudioMenu([
      { id: 'a', title: '   ', url: 'https://example.com' },
      { id: 'b', title: '', url: '' }
    ])
    expect(items.map((i) => (i.type === 'command' ? i.label : ''))).toEqual([
      'https://example.com',
      'Untitled tab'
    ])
  })
})
