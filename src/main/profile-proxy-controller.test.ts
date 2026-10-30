// The fail-closed contract of the per-profile proxy, tested on the controller the
// ProfileManager delegates to (an injected fake stands in for session.setProxy).
import { describe, it, expect } from 'vitest'
import {
  BLACKHOLE_PROXY,
  ProxyController,
  sessionTargetFor,
  type ProfileProxyConfig
} from './profile-proxy'

const P = 'persist:mira-test'
const PROXY = 'socks5://127.0.0.1:1080'
const URL_ = 'https://www.linkedin.com/'

/** A fake setProxy: records every call, resolves when released, can fail. */
function fakeApplier(): {
  calls: Array<{ partition: string; config: ProfileProxyConfig }>
  failRules: Set<string>
  hold: () => () => void
  applier: (partition: string, config: ProfileProxyConfig) => Promise<void>
} {
  const calls: Array<{ partition: string; config: ProfileProxyConfig }> = []
  const failRules = new Set<string>()
  let gate: Promise<void> | null = null
  return {
    calls,
    failRules,
    hold: () => {
      let release!: () => void
      gate = new Promise<void>((r) => (release = r))
      return () => {
        gate = null
        release()
      }
    },
    applier: async (partition, config) => {
      calls.push({ partition, config })
      if (gate) await gate
      const rules = config.mode === 'direct' ? 'direct' : config.proxyRules
      if (failRules.has(rules)) throw new Error(`setProxy failed: ${rules}`)
    }
  }
}

describe('ProxyController: guard 1+2, nothing loads before the proxy is confirmed', () => {
  it('blocks a proxied profile while setProxy is in flight, allows it once confirmed', async () => {
    const fake = fakeApplier()
    const ctl = new ProxyController(fake.applier)
    const profile = { id: 'test', proxy: PROXY }
    // Startup race: a load arrives before setProxy was even called.
    expect(ctl.gate(profile, P, URL_)).toMatch(/not confirmed/)
    const release = fake.hold()
    const ready = ctl.ensure(P, sessionTargetFor(profile))
    expect(ctl.gate(profile, P, URL_)).toMatch(/not confirmed/)
    release()
    await ready
    expect(ctl.gate(profile, P, URL_)).toBeNull()
    expect(ctl.applied(P)).toBe(PROXY)
  })

  it('never blocks Mira-internal pages (blank home, about:blank)', () => {
    const ctl = new ProxyController(fakeApplier().applier)
    const profile = { id: 'test', proxy: PROXY }
    expect(ctl.gate(profile, P, 'data:text/html,home')).toBeNull()
    expect(ctl.gate(profile, P, 'about:blank')).toBeNull()
  })

  it('a failed setProxy keeps the profile blocked and black-holes its session', async () => {
    const fake = fakeApplier()
    fake.failRules.add(PROXY)
    const ctl = new ProxyController(fake.applier)
    const profile = { id: 'test', proxy: PROXY }
    await expect(ctl.ensure(P, PROXY)).rejects.toThrow('setProxy failed')
    expect(ctl.gate(profile, P, URL_)).toMatch(/not confirmed/)
    // Session-level fail-closed: Chromium itself now refuses every request.
    expect(fake.calls.map((c) => c.config)).toEqual([
      { mode: 'fixed_servers', proxyRules: PROXY, proxyBypassRules: '<-loopback>' },
      { mode: 'fixed_servers', proxyRules: BLACKHOLE_PROXY, proxyBypassRules: '<-loopback>' }
    ])
    expect(ctl.applied(P)).toBe(BLACKHOLE_PROXY)
  })

  it('stays blocked even when the black hole cannot be applied either', async () => {
    const fake = fakeApplier()
    fake.failRules.add(PROXY)
    fake.failRules.add(BLACKHOLE_PROXY)
    const ctl = new ProxyController(fake.applier)
    await expect(ctl.ensure(P, PROXY)).rejects.toThrow('setProxy failed')
    expect(ctl.applied(P)).toBeUndefined()
    expect(ctl.gate({ id: 'test', proxy: PROXY }, P, URL_)).toMatch(/hard-blocked/)
  })

  it('leaves a never-proxied session alone and never blocks it', async () => {
    const fake = fakeApplier()
    const ctl = new ProxyController(fake.applier)
    await ctl.ensure(P, null)
    expect(fake.calls).toEqual([])
    expect(ctl.gate({ id: 'plain' }, P, URL_)).toBeNull()
  })
})

describe('ProxyController: guard 3, the stored setting never lies', () => {
  it('applies first and commits only on success', async () => {
    const fake = fakeApplier()
    const ctl = new ProxyController(fake.applier)
    const order: string[] = []
    const release = fake.hold()
    const done = ctl.change(P, true, null, PROXY, () => order.push('commit'))
    await Promise.resolve()
    expect(order).toEqual([]) // nothing persisted while setProxy is in flight
    release()
    await done
    expect(order).toEqual(['commit'])
    expect(ctl.applied(P)).toBe(PROXY)
  })

  it('on failure: no commit, the previous proxy is put back, the old profile stays proxied', async () => {
    const fake = fakeApplier()
    const ctl = new ProxyController(fake.applier)
    await ctl.ensure(P, PROXY)
    const NEXT = 'socks5://127.0.0.1:2080'
    fake.failRules.add(NEXT)
    let committed = false
    await expect(ctl.change(P, true, PROXY, NEXT, () => (committed = true))).rejects.toThrow(
      'setProxy failed'
    )
    expect(committed).toBe(false)
    expect(ctl.applied(P)).toBe(PROXY)
    expect(ctl.gate({ id: 'test', proxy: PROXY }, P, URL_)).toBeNull()
  })

  it('a profile without a live session (locked, closed default) commits without applying', async () => {
    const fake = fakeApplier()
    const ctl = new ProxyController(fake.applier)
    let committed = false
    await ctl.change(P, false, null, PROXY, () => (committed = true))
    expect(committed).toBe(true)
    expect(fake.calls).toEqual([])
    // And it is blocked until its session is configured (the unlock path).
    expect(ctl.gate({ id: 'test', proxy: PROXY }, P, URL_)).toMatch(/not confirmed/)
  })
})

describe('ProxyController: guard 4, an invalid stored proxy blocks the profile', () => {
  it('targets the black hole and refuses every load, with the raw value in the reason', async () => {
    const fake = fakeApplier()
    const ctl = new ProxyController(fake.applier)
    const profile = { id: 'test', proxyInvalid: 'socks5://127.0.0.1:1080;DIRECT' }
    expect(sessionTargetFor(profile)).toBe(BLACKHOLE_PROXY)
    await ctl.ensure(P, sessionTargetFor(profile))
    expect(ctl.applied(P)).toBe(BLACKHOLE_PROXY)
    expect(ctl.gate(profile, P, URL_)).toBe(
      'profile test has an invalid proxy setting (socks5://127.0.0.1:1080;DIRECT): refusing to load https://www.linkedin.com/; set a valid proxy or clear it'
    )
  })

  it('blocks the default profile too, which has no partition to black-hole', () => {
    const ctl = new ProxyController(fakeApplier().applier)
    expect(ctl.gate({ id: 'default', proxyInvalid: 'x' }, undefined, URL_)).toMatch(
      /invalid proxy setting/
    )
  })
})
