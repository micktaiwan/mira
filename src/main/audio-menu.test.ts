import { describe, it, expect } from 'vitest'
import { buildAudioMenu, AUDIO_MENU_LIMIT } from './audio-menu'
import type { AudioHistoryEntry } from './commands/audio-history'

const NOW = 1_800_000_000_000
const MIN = 60_000

function entry(over: Partial<AudioHistoryEntry> & { tabId: string }): AudioHistoryEntry {
  return {
    profileId: 'p1',
    profileLabel: 'Pro',
    title: over.tabId,
    url: `https://${over.tabId}.example.com`,
    favicon: null,
    lastAudibleAt: NOW,
    audible: false,
    ...over
  }
}

describe('buildAudioMenu', () => {
  it('shows a disabled placeholder when no tab has sounded', () => {
    expect(buildAudioMenu([], NOW)).toEqual([
      { type: 'disabled', label: 'No tab has played sound yet' }
    ])
  })

  it('lists tabs most recent first, playing ones on top, with time ago', () => {
    const items = buildAudioMenu(
      [
        entry({ tabId: 'slack', title: 'Slack', lastAudibleAt: NOW - 5 * MIN }),
        entry({ tabId: 'mail', title: 'Gmail', lastAudibleAt: NOW - 2 * MIN }),
        entry({ tabId: 'yt', title: 'YouTube', lastAudibleAt: NOW - 30 * MIN, audible: true })
      ],
      NOW
    )
    expect(items).toEqual([
      {
        type: 'command',
        command: 'activate-tab',
        params: { id: 'yt' },
        label: 'YouTube — playing now'
      },
      {
        type: 'command',
        command: 'activate-tab',
        params: { id: 'mail' },
        label: 'Gmail — 2 min ago'
      },
      {
        type: 'command',
        command: 'activate-tab',
        params: { id: 'slack' },
        label: 'Slack — 5 min ago'
      }
    ])
  })

  it(`keeps only the ${AUDIO_MENU_LIMIT} most recent tabs`, () => {
    const entries = Array.from({ length: 15 }, (_, i) =>
      entry({ tabId: `t${i}`, lastAudibleAt: NOW - i * MIN })
    )
    const items = buildAudioMenu(entries, NOW)
    expect(items).toHaveLength(AUDIO_MENU_LIMIT)
    expect(items.map((i) => (i.type === 'command' ? i.params.id : null))).toEqual(
      Array.from({ length: AUDIO_MENU_LIMIT }, (_, i) => `t${i}`)
    )
  })

  it('names the profile only when tabs span several profiles', () => {
    const items = buildAudioMenu(
      [
        entry({ tabId: 'a', title: 'A' }),
        entry({ tabId: 'b', title: 'B', profileId: 'p2', profileLabel: 'Perso' })
      ],
      NOW
    )
    expect(items.map((i) => i.label)).toEqual(['A (Pro) — just now', 'B (Perso) — just now'])
  })

  it('falls back to the url, then a generic label, when the title is blank', () => {
    const items = buildAudioMenu(
      [
        entry({ tabId: 'a', title: '   ', url: 'https://example.com' }),
        entry({ tabId: 'b', title: '', url: '', lastAudibleAt: NOW - MIN })
      ],
      NOW
    )
    expect(items.map((i) => i.label)).toEqual([
      'https://example.com — just now',
      'Untitled tab — 1 min ago'
    ])
  })
})
