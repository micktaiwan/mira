import { describe, it, expect } from 'vitest'
import {
  AUTO_SLEEP_IDLE_MS,
  autoSleepCandidates,
  isTypingInput,
  keepForText,
  lastUsedAt
} from './auto-sleep'
import type { TabMeta, TabState } from './tab-store'

const NOW = 1_800_000_000_000
const OLD = NOW - AUTO_SLEEP_IDLE_MS - 1
const RECENT = NOW - 60_000

function tab(id: string, extra: Partial<TabMeta> = {}): TabMeta {
  return { id, title: id, url: `https://${id}.example`, favicon: null, ...extra }
}

function run(
  tabs: TabMeta[],
  activeId: string | null,
  audible: string[] = [],
  seen: Record<string, number> = {}
): string[] {
  const state: TabState = { tabs, activeId }
  const loaded = new Set(tabs.map((t) => t.id))
  return autoSleepCandidates(state, loaded, new Set(audible), new Map(Object.entries(seen)), NOW)
}

describe('lastUsedAt', () => {
  it('prefers the last activation, falls back to the opening, else unknown', () => {
    expect(lastUsedAt(tab('a', { lastActiveAt: 5, openedAt: 1 }))).toBe(5)
    expect(lastUsedAt(tab('a', { openedAt: 1 }))).toBe(1)
    expect(lastUsedAt(tab('a'))).toBeNull()
  })

  it('takes the later of the stamp and the last time the sweep saw it active', () => {
    expect(lastUsedAt(tab('a', { lastActiveAt: 5 }), 9)).toBe(9)
    expect(lastUsedAt(tab('a', { lastActiveAt: 9 }), 5)).toBe(9)
    expect(lastUsedAt(tab('a'), 7)).toBe(7)
  })
})

describe('autoSleepCandidates', () => {
  it('picks a loaded tab unseen for longer than the idle delay', () => {
    expect(
      run([tab('a', { lastActiveAt: OLD }), tab('b', { lastActiveAt: RECENT })], null)
    ).toEqual(['a'])
  })

  it('counts from the opening for a tab never made active (opened in the background)', () => {
    expect(run([tab('agent', { openedAt: RECENT })], null)).toEqual([])
    expect(run([tab('agent', { openedAt: OLD })], null)).toEqual(['agent'])
  })

  it('counts from when the tab was left, not from when it was brought to the front', () => {
    // Brought to the front long ago, but the sweep saw it on screen a minute ago.
    expect(
      run([tab('read-all-day', { lastActiveAt: OLD })], null, [], { 'read-all-day': RECENT })
    ).toEqual([])
  })

  it('leaves a tab of unknown age alone', () => {
    expect(run([tab('legacy')], null)).toEqual([])
  })

  it('never picks the active, pinned, keep-awake or audible tab', () => {
    const tabs = [
      tab('active', { lastActiveAt: OLD }),
      tab('pinned', { lastActiveAt: OLD, pinned: true }),
      tab('awake', { lastActiveAt: OLD, keepAwake: true }),
      tab('music', { lastActiveAt: OLD }),
      tab('plain', { lastActiveAt: OLD })
    ]
    expect(run(tabs, 'active', ['music'])).toEqual(['plain'])
  })

  it('skips a tab that is already asleep (no live view)', () => {
    const state: TabState = { tabs: [tab('a', { lastActiveAt: OLD })], activeId: null }
    expect(autoSleepCandidates(state, new Set(), new Set(), new Map(), NOW)).toEqual([])
  })
})

describe('isTypingInput', () => {
  it('counts printable keys, Backspace and Delete', () => {
    expect(isTypingInput({ type: 'keyDown', key: 'a' })).toBe(true)
    expect(isTypingInput({ type: 'keyDown', key: 'é' })).toBe(true)
    expect(isTypingInput({ type: 'keyDown', key: 'Backspace' })).toBe(true)
  })

  it('ignores shortcuts, navigation keys and key releases', () => {
    expect(isTypingInput({ type: 'keyDown', key: 'c', meta: true })).toBe(false)
    expect(isTypingInput({ type: 'keyDown', key: 'ArrowDown' })).toBe(false)
    expect(isTypingInput({ type: 'keyDown', key: 'Enter' })).toBe(false)
    expect(isTypingInput({ type: 'keyUp', key: 'a' })).toBe(false)
  })
})

describe('keepForText', () => {
  it('lets a tab the user never typed in sleep, whatever the page holds', () => {
    expect(keepForText(false, true)).toBe(false)
  })

  it('keeps a typed-in tab whose field still holds text', () => {
    expect(keepForText(true, true)).toBe(true)
  })

  it('lets a typed-in tab sleep once its fields are empty (the text was sent)', () => {
    expect(keepForText(true, false)).toBe(false)
  })

  it('keeps a typed-in tab whose page did not answer the probe', () => {
    expect(keepForText(true, new Error('timeout'))).toBe(true)
  })
})
