import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'
import type { PageConsoleEntry } from '../page-console'

const registry = createCommandRegistry()

describe('get-console command', () => {
  it('reads the active tab console when no tabId is given', () => {
    const fake = makeContext()
    fake.seedPageConsole('tab-1', { level: 'info', message: 'hello', source: 'console' })
    fake.seedPageConsole('tab-1', {
      level: 'error',
      message: 'Failed to load resource: 403',
      source: 'network'
    })
    const res = registry.execute('get-console', {}, fake.ctx) as {
      ok: boolean
      messages: PageConsoleEntry[]
    }
    expect(res.ok).toBe(true)
    expect(res.messages.map((m) => m.message)).toEqual(['hello', 'Failed to load resource: 403'])
  })

  it('floors by level', () => {
    const fake = makeContext()
    fake.seedPageConsole('tab-1', { level: 'info', message: 'i', source: 'console' })
    fake.seedPageConsole('tab-1', { level: 'error', message: 'e', source: 'network' })
    const res = registry.execute('get-console', { level: 'error' }, fake.ctx) as {
      ok: boolean
      messages: PageConsoleEntry[]
    }
    expect(res.messages.map((m) => m.message)).toEqual(['e'])
  })

  it('caps to the most recent N via limit', () => {
    const fake = makeContext()
    for (let i = 0; i < 4; i++) {
      fake.seedPageConsole('tab-1', { level: 'info', message: `m${i}`, source: 'console' })
    }
    const res = registry.execute('get-console', { limit: 2 }, fake.ctx) as {
      ok: boolean
      messages: PageConsoleEntry[]
    }
    expect(res.messages.map((m) => m.message)).toEqual(['m2', 'm3'])
  })

  it('returns [] for a tab with no captured console', () => {
    const fake = makeContext()
    expect(registry.execute('get-console', {}, fake.ctx)).toEqual({ ok: true, messages: [] })
  })

  it('rejects an unknown tabId', () => {
    const fake = makeContext()
    expect(registry.execute('get-console', { tabId: 'nope' }, fake.ctx)).toMatchObject({
      ok: false,
      error: 'unknown tab: nope'
    })
  })

  it('rejects an invalid level or limit', () => {
    const fake = makeContext()
    expect(registry.execute('get-console', { level: 'loud' }, fake.ctx)).toMatchObject({
      ok: false
    })
    expect(registry.execute('get-console', { limit: 0 }, fake.ctx)).toMatchObject({ ok: false })
    expect(registry.execute('get-console', { tabId: '' }, fake.ctx)).toMatchObject({ ok: false })
    expect(registry.execute('get-console', { sinceSeq: -1 }, fake.ctx)).toMatchObject({
      ok: false
    })
  })
})
