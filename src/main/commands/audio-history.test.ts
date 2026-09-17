import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'
import { rankAudioHistory, type AudioHistoryEntry } from './audio-history'

function entry(over: Partial<AudioHistoryEntry>): AudioHistoryEntry {
  return {
    tabId: 't',
    profileId: 'p',
    profileLabel: 'P',
    title: '',
    url: 'https://a.test/',
    favicon: null,
    lastAudibleAt: 0,
    audible: false,
    ...over
  }
}

describe('rankAudioHistory', () => {
  it('puts the most recent sound first', () => {
    const ranked = rankAudioHistory([
      entry({ tabId: 'old', lastAudibleAt: 100 }),
      entry({ tabId: 'new', lastAudibleAt: 300 }),
      entry({ tabId: 'mid', lastAudibleAt: 200 })
    ])
    expect(ranked.map((e) => e.tabId)).toEqual(['new', 'mid', 'old'])
  })

  it('ranks a tab playing right now above a more recent stamp', () => {
    const ranked = rankAudioHistory([
      entry({ tabId: 'quiet', lastAudibleAt: 500 }),
      entry({ tabId: 'playing', lastAudibleAt: 100, audible: true })
    ])
    expect(ranked.map((e) => e.tabId)).toEqual(['playing', 'quiet'])
  })

  it('breaks ties by tab id and leaves the input untouched', () => {
    const input = [entry({ tabId: 'b', lastAudibleAt: 1 }), entry({ tabId: 'a', lastAudibleAt: 1 })]
    expect(rankAudioHistory(input).map((e) => e.tabId)).toEqual(['a', 'b'])
    expect(input.map((e) => e.tabId)).toEqual(['b', 'a'])
  })
})

describe('list-audio-history', () => {
  it('returns the context entries ranked most recent first', () => {
    const { ctx } = makeContext()
    ctx.listAudioHistory = () => [
      entry({ tabId: 'tab-1', lastAudibleAt: 10 }),
      entry({ tabId: 'tab-2', lastAudibleAt: 20 })
    ]
    const res = createCommandRegistry().execute('list-audio-history', {}, ctx) as {
      ok: true
      entries: AudioHistoryEntry[]
    }
    expect(res.ok).toBe(true)
    expect(res.entries.map((e) => e.tabId)).toEqual(['tab-2', 'tab-1'])
  })

  it('is empty when no tab ever made a sound', () => {
    const { ctx } = makeContext()
    expect(createCommandRegistry().execute('list-audio-history', {}, ctx)).toEqual({
      ok: true,
      entries: []
    })
  })
})
