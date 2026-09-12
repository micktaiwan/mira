import { describe, expect, it, vi } from 'vitest'
import {
  CHECK_INTERVAL_SECS,
  RETRY_SECS,
  UpdateChecker,
  formatVersion,
  isNewer,
  outcomeFor,
  parseVersion,
  releasePage,
  type Outcome,
  type UpdateState
} from './update-check'

describe('parseVersion', () => {
  it('accepts a tag with or without the v prefix, padding missing components', () => {
    expect(parseVersion('v1.10.0')).toEqual([1, 10, 0])
    expect(parseVersion('1.10.2')).toEqual([1, 10, 2])
    expect(parseVersion('v2')).toEqual([2, 0, 0])
    expect(parseVersion('v1.11')).toEqual([1, 11, 0])
  })

  it('refuses what is not a plain version', () => {
    // A pre-release must never announce itself as an update.
    expect(parseVersion('v1.11.0-beta')).toBeNull()
    expect(parseVersion('1.2.3.4')).toBeNull()
    expect(parseVersion('')).toBeNull()
    expect(parseVersion('latest')).toBeNull()
  })
})

describe('isNewer', () => {
  it('compares numerically, not as text', () => {
    expect(isNewer([1, 10, 0], [1, 9, 0])).toBe(true)
    expect(isNewer([1, 9, 0], [1, 10, 0])).toBe(false)
    expect(isNewer([1, 10, 0], [1, 10, 0])).toBe(false)
    expect(isNewer([1, 0, 1], [1, 0, 0])).toBe(true)
  })
})

describe('outcomeFor', () => {
  it('stays silent on the daily check when up to date', () => {
    expect(outcomeFor([1, 10, 0], [1, 10, 0], null, false)).toBeNull()
  })

  it('announces a version once', () => {
    expect(outcomeFor([1, 11, 0], [1, 10, 0], '1.11.0', false)).toBeNull()
    expect(outcomeFor([1, 12, 0], [1, 10, 0], '1.11.0', false)).toEqual({
      kind: 'newer',
      version: [1, 12, 0]
    })
  })

  it('always answers a check that was asked for', () => {
    expect(outcomeFor([1, 10, 0], [1, 10, 0], null, true)).toEqual({ kind: 'up-to-date' })
    expect(outcomeFor([1, 11, 0], [1, 10, 0], '1.11.0', true)).toEqual({
      kind: 'newer',
      version: [1, 11, 0]
    })
  })
})

describe('releasePage', () => {
  it('is built from the parsed version, never from the API response', () => {
    expect(releasePage([1, 11, 0])).toBe('https://github.com/micktaiwan/mira/releases/tag/v1.11.0')
  })
})

describe('formatVersion', () => {
  it('renders the triple', () => {
    expect(formatVersion([1, 2, 3])).toBe('1.2.3')
  })
})

/** A checker wired on a fake clock, a fake network and an in-memory state file. */
function harness(opts: {
  current?: string
  tag?: string | Error
  state?: Partial<UpdateState>
  now?: number
}) {
  let now = opts.now ?? 1_000_000
  let state: UpdateState = { lastCheck: 0, notifiedVersion: null, ...opts.state }
  const shown: Outcome[] = []
  const fetchLatestTag = vi.fn(async () => {
    if (opts.tag instanceof Error) throw opts.tag
    return opts.tag ?? 'v1.1.0'
  })
  const checker = new UpdateChecker({
    currentVersion: opts.current ?? '1.0.0',
    fetchLatestTag,
    now: () => now,
    loadState: () => state,
    saveState: (s) => {
      state = s
    },
    notify: (outcome) => {
      shown.push(outcome)
    },
    log: () => {}
  })
  return {
    checker,
    fetchLatestTag,
    shown,
    get state() {
      return state
    },
    advance: (secs: number) => {
      now += secs
    }
  }
}

describe('UpdateChecker', () => {
  it('announces a newer release and remembers it, so the next daily check is silent', async () => {
    const h = harness({ current: '1.0.0', tag: 'v1.1.0' })
    await h.checker.checkNow()
    expect(h.shown).toEqual([{ kind: 'newer', version: [1, 1, 0] }])
    expect(h.state.notifiedVersion).toBe('1.1.0')

    h.advance(CHECK_INTERVAL_SECS + 1)
    await h.checker.poll()
    expect(h.shown).toHaveLength(1)
  })

  it('says nothing on a due daily check when there is nothing new', async () => {
    const h = harness({ current: '1.1.0', tag: 'v1.1.0' })
    h.advance(CHECK_INTERVAL_SECS)
    await h.checker.poll()
    expect(h.fetchLatestTag).toHaveBeenCalledOnce()
    expect(h.shown).toEqual([])
  })

  it('does not hit the network before the check is due', async () => {
    const h = harness({ state: { lastCheck: 1_000_000 }, now: 1_000_000 })
    await h.checker.poll()
    expect(h.fetchLatestTag).not.toHaveBeenCalled()

    h.advance(CHECK_INTERVAL_SECS)
    await h.checker.poll()
    expect(h.fetchLatestTag).toHaveBeenCalledOnce()
  })

  it('reports a failure only when the check was asked for, and retries within the hour', async () => {
    const h = harness({ tag: new Error('offline') })
    h.advance(CHECK_INTERVAL_SECS)
    await h.checker.poll()
    expect(h.shown).toEqual([])
    // The failure did not count as a check: the retry is an hour out, not a day.
    expect(h.state.lastCheck).toBe(0)

    h.advance(RETRY_SECS - 1)
    await h.checker.poll()
    expect(h.fetchLatestTag).toHaveBeenCalledOnce()
    h.advance(1)
    await h.checker.poll()
    expect(h.fetchLatestTag).toHaveBeenCalledTimes(2)
  })

  it('surfaces the error text on a manual check', async () => {
    const h = harness({ tag: new Error('offline') })
    await h.checker.checkNow()
    expect(h.shown).toEqual([{ kind: 'failed', error: 'offline' }])
  })

  it('treats an unparsable tag as a failure rather than an update', async () => {
    const h = harness({ tag: 'nightly' })
    await h.checker.checkNow()
    expect(h.shown).toEqual([{ kind: 'failed', error: 'unparsable tag "nightly"' }])
  })

  it('runs one request at a time', async () => {
    const h = harness({})
    await Promise.all([h.checker.checkNow(), h.checker.checkNow()])
    expect(h.fetchLatestTag).toHaveBeenCalledOnce()
  })
})
