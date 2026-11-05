import { describe, expect, it, vi } from 'vitest'
import { FreezeWatchdog, MISSES_TO_FREEZE, WATCH_WINDOW_MS, type WatchdogDeps } from './freeze-watchdog'

vi.mock('electron', () => ({ app: {} }))

function setup(over: Partial<WatchdogDeps> = {}) {
  const clock = { t: 1000 }
  const answers = { ok: false }
  const skipped = new Set<string>()
  const ruledOut = new Set<string>()
  const recover = vi.fn()
  const deps: WatchdogDeps = {
    probe: async () => answers.ok,
    cpuPercent: () => 99,
    host: () => 'site.test',
    isSkipped: (h) => skipped.has(h),
    isRuledOut: (h) => ruledOut.has(h),
    learn: (h) => skipped.add(h),
    ruleOut: (h) => {
      skipped.delete(h)
      ruledOut.add(h)
    },
    recover,
    log: () => {},
    now: () => clock.t,
    ...over
  }
  const dog = new FreezeWatchdog(deps)
  const freeze = async (): Promise<void> => {
    for (let i = 0; i < MISSES_TO_FREEZE; i++) await dog.tick()
  }
  return { dog, clock, answers, skipped, ruledOut, recover, freeze }
}

describe('FreezeWatchdog', () => {
  it('does nothing outside the window after a navigation', async () => {
    const { dog, recover, freeze, clock } = setup()
    await freeze()
    expect(recover).not.toHaveBeenCalled()
    dog.onNavigate()
    clock.t += WATCH_WINDOW_MS + 1
    await freeze()
    expect(recover).not.toHaveBeenCalled()
  })

  it('skips the host and reloads a page that stays frozen with a busy renderer', async () => {
    const { dog, recover, skipped, freeze } = setup()
    dog.onNavigate()
    await freeze()
    expect(skipped.has('site.test')).toBe(true)
    expect(recover).toHaveBeenCalledTimes(1)
  })

  it('follows a freeze that began late in the window past its end', async () => {
    const { dog, recover, clock, freeze } = setup()
    dog.onNavigate()
    clock.t += WATCH_WINDOW_MS - 1
    await dog.tick()
    clock.t += 2
    await freeze()
    expect(recover).toHaveBeenCalledTimes(1)
  })

  it('leaves alone a page that does not answer on an idle renderer (an alert)', async () => {
    const { dog, recover, freeze } = setup({ cpuPercent: () => 0 })
    dog.onNavigate()
    await freeze()
    await freeze()
    expect(recover).not.toHaveBeenCalled()
  })

  it('forgets a slow moment when the page answers again', async () => {
    const { dog, recover, answers } = setup()
    dog.onNavigate()
    await dog.tick()
    await dog.tick()
    answers.ok = true
    await dog.tick()
    answers.ok = false
    await dog.tick()
    await dog.tick()
    expect(recover).not.toHaveBeenCalled()
  })

  it('keeps the skip when the reload helped', async () => {
    const { dog, skipped, answers, freeze } = setup()
    dog.onNavigate()
    await freeze()
    dog.onNavigate() // the reload
    answers.ok = true
    await dog.tick()
    expect(skipped.has('site.test')).toBe(true)
  })

  it('does not blame the reload for a freeze long after it', async () => {
    const { dog, skipped, ruledOut, clock, freeze } = setup()
    dog.onNavigate()
    await freeze()
    clock.t += WATCH_WINDOW_MS + 1
    dog.onNavigate()
    await freeze()
    expect(skipped.has('site.test')).toBe(true)
    expect(ruledOut.has('site.test')).toBe(false)
  })

  it('rules the host out and stops reloading when it freezes again', async () => {
    const { dog, recover, skipped, ruledOut, freeze } = setup()
    dog.onNavigate()
    await freeze()
    dog.onNavigate() // the reload
    await freeze()
    expect(skipped.has('site.test')).toBe(false)
    expect(ruledOut.has('site.test')).toBe(true)
    expect(recover).toHaveBeenCalledTimes(1)
    dog.onNavigate()
    await freeze()
    expect(recover).toHaveBeenCalledTimes(1)
  })

  it('does not write back a host wiped since the reload', async () => {
    const { dog, recover, skipped, ruledOut, freeze } = setup()
    dog.onNavigate()
    await freeze()
    skipped.clear() // clear-history or forget-domain
    dog.onNavigate()
    await freeze()
    expect(ruledOut.has('site.test')).toBe(false)
    expect(skipped.has('site.test')).toBe(false)
    expect(recover).toHaveBeenCalledTimes(1)
  })

  it('never reloads a host already skipped', async () => {
    const { dog, recover, skipped, freeze } = setup()
    skipped.add('site.test')
    dog.onNavigate()
    await freeze()
    expect(recover).not.toHaveBeenCalled()
  })

  it('does not run two probes at once', async () => {
    const probe = vi.fn(() => new Promise<boolean>(() => {}))
    const { dog } = setup({ probe })
    dog.onNavigate()
    void dog.tick()
    void dog.tick()
    expect(probe).toHaveBeenCalledTimes(1)
  })
})
