import { describe, expect, it } from 'vitest'
import { SessionWindowRegistry, sessionWindowProfile } from './session-windows'

const open =
  (...ids: string[]) =>
  (id: string): boolean =>
    ids.includes(id)

describe('SessionWindowRegistry', () => {
  it('returns the bound window while it is open', () => {
    const r = new SessionWindowRegistry()
    r.bind('s1', 'pro', 'w1', 42)
    expect(r.lookup('s1', 'pro', open('w1'))).toEqual({ windowId: 'w1' })
    expect(r.lookup('s1', undefined, open('w1'))).toEqual({ windowId: 'w1' })
    expect(r.owns('w1')).toBe(true)
  })

  it('keeps sessions apart', () => {
    const r = new SessionWindowRegistry()
    r.bind('s1', 'pro', 'w1')
    r.bind('s2', 'pro', 'w2')
    expect(r.lookup('s1', 'pro', open('w1', 'w2'))).toEqual({ windowId: 'w1' })
    expect(r.lookup('s2', 'pro', open('w1', 'w2'))).toEqual({ windowId: 'w2' })
  })

  it('keeps one window per profile, and refuses to pick one when none is named', () => {
    const r = new SessionWindowRegistry()
    r.bind('s1', 'pro', 'w1')
    r.bind('s1', 'perso', 'w2')
    expect(r.lookup('s1', 'perso', open('w1', 'w2'))).toEqual({ windowId: 'w2' })
    expect(r.lookup('s1', 'other', open('w1', 'w2'))).toEqual({ none: true })
    expect(r.lookup('s1', undefined, open('w1', 'w2'))).toEqual({
      ambiguous: [
        { windowId: 'w1', profileId: 'pro' },
        { windowId: 'w2', profileId: 'perso' }
      ]
    })
  })

  it('drops a binding whose window the user closed', () => {
    const r = new SessionWindowRegistry()
    r.bind('s1', 'pro', 'w1')
    expect(r.lookup('s1', undefined, open())).toEqual({ none: true })
    expect(r.owns('w1')).toBe(false)
  })

  it('unbind returns every window of the session', () => {
    const r = new SessionWindowRegistry()
    r.bind('s1', 'pro', 'w1')
    r.bind('s1', 'perso', 'w2')
    r.bind('s2', 'pro', 'w3')
    expect(r.unbind('s1')).toEqual(['w1', 'w2'])
    expect(r.unbind('s1')).toEqual([])
    expect(r.size).toBe(1)
  })

  it('reaps the windows of a dead process, not of a live one', () => {
    const r = new SessionWindowRegistry()
    r.bind('dead', 'pro', 'w1', 1)
    r.bind('alive', 'pro', 'w2', 2)
    r.bind('nopid', 'pro', 'w3')
    expect(r.reap((pid) => pid === 2, open('w1', 'w2', 'w3'))).toEqual(['w1'])
    expect(r.size).toBe(2)
  })

  it('forgets a binding whose window is already gone without closing anything', () => {
    const r = new SessionWindowRegistry()
    r.bind('s1', 'pro', 'w1', 1)
    expect(r.reap(() => false, open())).toEqual([])
    expect(r.size).toBe(0)
  })
})

describe('sessionWindowProfile', () => {
  it('takes the named profile', () => {
    expect(
      sessionWindowProfile({ requested: 'p1', openProfiles: ['p2', 'p3'], fallback: 'd' })
    ).toEqual({
      profileId: 'p1'
    })
  })

  it('takes the only open profile, or the default when Mira has no window', () => {
    expect(sessionWindowProfile({ openProfiles: ['p2', 'p2'], fallback: 'd' })).toEqual({
      profileId: 'p2'
    })
    expect(sessionWindowProfile({ openProfiles: [], fallback: 'd' })).toEqual({ profileId: 'd' })
  })

  it('refuses to guess between several open profiles', () => {
    expect(sessionWindowProfile({ openProfiles: ['p1', 'p2'], fallback: 'd' })).toMatchObject({
      error: expect.stringContaining('--profile')
    })
  })
})
