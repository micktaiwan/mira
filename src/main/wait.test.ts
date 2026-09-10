import { describe, it, expect } from 'vitest'
import {
  DEFAULT_WAIT_MS,
  MAX_WAIT_MS,
  describeCondition,
  parseWaitParams,
  pollUntil,
  waitProbeScript,
  waitTimeoutMessage,
  type WaitCondition
} from './wait'
import type { ParsedWait } from './wait'

/** Narrow a parse result to the error side (or fail the test saying why). */
function refusal(result: ParsedWait | { error: string }): string {
  if (!('error' in result)) throw new Error('expected a refusal, got a parsed condition')
  return result.error
}

const cond = (over: Partial<WaitCondition> = {}): WaitCondition => ({
  kind: 'selector',
  value: '.x',
  gone: false,
  ...over
})

describe('parseWaitParams', () => {
  it('takes one condition and defaults the timeout', () => {
    expect(parseWaitParams({ selector: '[role=dialog]' })).toEqual({
      condition: { kind: 'selector', value: '[role=dialog]', gone: false },
      timeoutMs: DEFAULT_WAIT_MS
    })
  })

  it('carries gone, a tabId and an explicit timeout', () => {
    expect(parseWaitParams({ text: 'People', gone: true, tabId: 't1', timeoutMs: 1500 })).toEqual({
      condition: { kind: 'text', value: 'People', gone: true },
      timeoutMs: 1500,
      tabId: 't1'
    })
  })

  it('refuses no condition, and refuses two at once', () => {
    expect(parseWaitParams({})).toEqual({
      error: 'missing condition: "selector", "text" or "url"'
    })
    expect(parseWaitParams({ selector: 'a', url: '/x' })).toEqual({
      error: 'one condition at a time, got "selector" and "url"'
    })
  })

  it('refuses a junk timeout rather than silently using the default', () => {
    expect(refusal(parseWaitParams({ selector: 'a', timeoutMs: 0 }))).toMatch(/positive number/)
    expect(refusal(parseWaitParams({ selector: 'a', timeoutMs: '5s' }))).toMatch(/positive number/)
    expect(refusal(parseWaitParams({ selector: 'a', timeoutMs: MAX_WAIT_MS + 1 }))).toMatch(
      /capped/
    )
  })

  it('refuses a blank tabId', () => {
    expect(parseWaitParams({ selector: 'a', tabId: ' ' })).toEqual({ error: 'invalid "tabId"' })
  })
})

describe('waitProbeScript', () => {
  it('requires a selector match to have a real box, not just exist', () => {
    const js = waitProbeScript(cond({ value: '.spinner' }))
    expect(js).toContain('querySelector(".spinner")')
    expect(js).toContain('getBoundingClientRect')
  })

  it('matches text on rendered innerText, not textContent', () => {
    const js = waitProbeScript(cond({ kind: 'text', value: 'Settings' }))
    expect(js).toContain('innerText')
    expect(js).not.toContain('textContent')
    expect(js).toContain('"Settings"')
  })

  it('matches a url substring', () => {
    expect(waitProbeScript(cond({ kind: 'url', value: '/settings' }))).toContain(
      'location.href.includes("/settings")'
    )
  })

  it('negates the whole condition for gone', () => {
    expect(waitProbeScript(cond({ kind: 'url', value: '/x', gone: true }))).toMatch(/^!\(/)
  })

  it('escapes a value carrying quotes instead of breaking the script', () => {
    const js = waitProbeScript(cond({ kind: 'text', value: 'he said "no"' }))
    expect(js).toContain('"he said \\"no\\""')
  })
})

describe('pollUntil', () => {
  const fakeClock = (): { now: () => number; sleep: (ms: number) => Promise<void> } => {
    let t = 0
    return {
      now: () => t,
      sleep: (ms: number) => {
        t += ms
        return Promise.resolve()
      }
    }
  }

  it('returns as soon as the condition holds, with the time it really took', async () => {
    const clock = fakeClock()
    let calls = 0
    const r = await pollUntil({
      probe: async () => ++calls >= 3,
      timeoutMs: 5000,
      intervalMs: 100,
      ...clock
    })
    expect(r).toEqual({ ok: true, waitedMs: 200 })
    expect(calls).toBe(3)
  })

  it('probes at least once even with a budget smaller than the interval', async () => {
    // And never sleeps past the budget: the last nap is clamped to what is left,
    // so a 1 ms wait does not block for a 100 ms interval.
    const clock = fakeClock()
    let calls = 0
    const r = await pollUntil({
      probe: async () => {
        calls++
        return false
      },
      timeoutMs: 1,
      intervalMs: 100,
      ...clock
    })
    expect(calls).toBeGreaterThanOrEqual(1)
    expect(r).toEqual({ ok: false, waitedMs: 1, lastError: undefined })
  })

  it('gives up at the budget and reports how long it waited', async () => {
    const clock = fakeClock()
    const r = await pollUntil({
      probe: async () => false,
      timeoutMs: 250,
      intervalMs: 100,
      ...clock
    })
    expect(r.ok).toBe(false)
    expect(r.waitedMs).toBe(250)
  })

  it('treats a throwing probe as "not yet" and keeps the last error', async () => {
    // A page mid-navigation rejects evaluations for a beat — exactly the moment
    // worth waiting through, not the moment to give up.
    const clock = fakeClock()
    let calls = 0
    const r = await pollUntil({
      probe: async () => {
        if (++calls < 3) throw new Error('page is navigating')
        return true
      },
      timeoutMs: 5000,
      intervalMs: 50,
      ...clock
    })
    expect(r.ok).toBe(true)
    const failed = await pollUntil({
      probe: async () => {
        throw new Error('page is navigating')
      },
      timeoutMs: 100,
      intervalMs: 50,
      ...fakeClock()
    })
    expect(failed.lastError).toBe('page is navigating')
  })
})

describe('messages', () => {
  it('says what was watched, both ways', () => {
    expect(describeCondition(cond({ kind: 'text', value: 'People' }))).toBe('text "People" present')
    expect(describeCondition(cond({ value: '.spinner', gone: true }))).toBe(
      'selector ".spinner" gone'
    )
  })

  it('names the condition and the elapsed time on timeout', () => {
    expect(waitTimeoutMessage(cond({ value: '#go' }), 5000)).toBe(
      'timed out after 5000ms waiting for selector "#go" present'
    )
    expect(waitTimeoutMessage(cond(), 100, 'boom')).toContain('(last page error: boom)')
  })
})
