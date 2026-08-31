import { describe, it, expect } from 'vitest'
import {
  candidatesForHost,
  chooseLogin,
  fillHost,
  fillSite,
  forgetFillProfile,
  lastFill,
  mergeFillReports,
  readFillMemory,
  readFrameFillReport,
  redactCandidates,
  rememberFill,
  MAX_SITES_PER_PROFILE,
  type FillMemory
} from './login-fill'
import type { VaultLogin } from './bitwarden-login'

const item = (over: Partial<VaultLogin> = {}): VaultLogin => ({
  id: 'item-1',
  name: 'example.com',
  username: 'me@example.com',
  password: 'hunter22',
  hosts: ['example.com'],
  raw: {},
  ...over
})

describe('fillHost', () => {
  it('reads the host of a web page', () => {
    expect(fillHost('https://eu.holistics.io/users/sign_in')).toBe('eu.holistics.io')
  })

  it('keeps the port, which is part of the host', () => {
    expect(fillHost('http://localhost:5173/login')).toBe('localhost:5173')
  })

  it('refuses anything that is not http(s) — nothing to fill there', () => {
    expect(fillHost('about:blank')).toBe('')
    expect(fillHost('chrome-extension://abc/popup.html')).toBe('')
    expect(fillHost('file:///Users/mickaelfm/x.html')).toBe('')
    expect(fillHost('not a url')).toBe('')
    expect(fillHost('')).toBe('')
  })
})

describe('candidatesForHost', () => {
  it('offers the item filed under the exact host', () => {
    const items = [item({ id: 'a', hosts: ['eu.holistics.io'] })]
    expect(candidatesForHost(items, 'eu.holistics.io').map((i) => i.id)).toEqual(['a'])
  })

  it('offers a sibling subdomain of the same site, after the exact ones', () => {
    const items = [
      item({ id: 'sibling', username: 'a@x.com', hosts: ['apps.tiime.fr'] }),
      item({ id: 'exact', username: 'b@x.com', hosts: ['go.tiime.fr'] })
    ]
    expect(candidatesForHost(items, 'go.tiime.fr').map((i) => i.id)).toEqual(['exact', 'sibling'])
  })

  it('never crosses to another site, however similar the name', () => {
    const items = [item({ id: 'fr', hosts: ['lempire.fr'] })]
    expect(candidatesForHost(items, 'lempire.com')).toEqual([])
  })

  it('sorts within a rank by username then name, so the list is stable', () => {
    const items = [
      item({ id: 'c', username: 'zoe@x.com', hosts: ['example.com'] }),
      item({ id: 'a', username: 'ana@x.com', hosts: ['example.com'] }),
      item({ id: 'b', username: 'ana@x.com', name: 'zz', hosts: ['example.com'] })
    ]
    expect(candidatesForHost(items, 'example.com').map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  it('keeps an item that has no username: the password alone is still the point', () => {
    const items = [item({ id: 'nameless', username: '', hosts: ['example.com'] })]
    expect(candidatesForHost(items, 'example.com').map((i) => i.id)).toEqual(['nameless'])
  })

  it('answers nothing for an empty host rather than everything', () => {
    expect(candidatesForHost([item()], '')).toEqual([])
  })

  it('matches a host case-insensitively', () => {
    expect(candidatesForHost([item({ hosts: ['example.com'] })], 'EXAMPLE.COM')).toHaveLength(1)
  })
})

describe('redactCandidates', () => {
  it('drops the password and says which entries are filed under this host', () => {
    const items = [
      item({ id: 'exact', hosts: ['go.tiime.fr'] }),
      item({ id: 'site', hosts: ['apps.tiime.fr'] })
    ]
    const out = redactCandidates(items, 'go.tiime.fr')
    expect(out).toEqual([
      {
        id: 'exact',
        name: 'example.com',
        username: 'me@example.com',
        hosts: ['go.tiime.fr'],
        exact: true
      },
      {
        id: 'site',
        name: 'example.com',
        username: 'me@example.com',
        hosts: ['apps.tiime.fr'],
        exact: false
      }
    ])
    expect(JSON.stringify(out)).not.toContain('hunter22')
  })
})

describe('chooseLogin', () => {
  const two = [item({ id: 'a', username: 'ana@x.com' }), item({ id: 'b', username: 'bob@x.com' })]

  it('takes the only candidate there is', () => {
    expect(chooseLogin([two[0]])).toEqual({ pick: two[0], reason: 'ok' })
  })

  it('refuses to guess between two accounts', () => {
    expect(chooseLogin(two)).toEqual({ pick: null, reason: 'ambiguous' })
  })

  it('breaks the tie with the account used last time on this site', () => {
    expect(chooseLogin(two, { lastUsedId: 'b' })).toEqual({ pick: two[1], reason: 'ok' })
  })

  it('ignores a remembered id the page no longer matches', () => {
    expect(chooseLogin(two, { lastUsedId: 'gone' })).toEqual({ pick: null, reason: 'ambiguous' })
  })

  it('obeys an explicit id', () => {
    expect(chooseLogin(two, { id: 'b' })).toEqual({ pick: two[1], reason: 'ok' })
  })

  it('refuses an id that is not among the candidates rather than filling another', () => {
    expect(chooseLogin(two, { id: 'elsewhere' })).toEqual({ pick: null, reason: 'unknown-id' })
  })

  it('obeys an explicit username, case-insensitively', () => {
    expect(chooseLogin(two, { username: 'BOB@X.COM' })).toEqual({ pick: two[1], reason: 'ok' })
  })

  it('reports an unknown username instead of falling back to the first', () => {
    expect(chooseLogin(two, { username: 'zoe@x.com' })).toEqual({
      pick: null,
      reason: 'unknown-username'
    })
  })

  it('stays ambiguous when two items share the requested username', () => {
    const same = [item({ id: 'a' }), item({ id: 'b' })]
    expect(chooseLogin(same, { username: 'me@example.com' })).toEqual({
      pick: null,
      reason: 'ambiguous'
    })
  })

  it('says no-match on an empty vault, which is a different problem', () => {
    expect(chooseLogin([])).toEqual({ pick: null, reason: 'no-match' })
  })

  it('lets an explicit id win over the remembered one', () => {
    expect(chooseLogin(two, { id: 'a', lastUsedId: 'b' })).toEqual({ pick: two[0], reason: 'ok' })
  })
})

describe('the remembered choice', () => {
  it('reads back what it wrote', () => {
    const memory = rememberFill({}, 'perso', 'tiime.fr', 'item-9')
    expect(lastFill(memory, 'perso', 'tiime.fr')).toBe('item-9')
  })

  it('answers null for a site never chosen on', () => {
    expect(lastFill({}, 'perso', 'tiime.fr')).toBeNull()
  })

  it('never leaks a choice from one profile into another', () => {
    const memory = rememberFill({}, 'perso', 'tiime.fr', 'item-9')
    expect(lastFill(memory, 'pro', 'tiime.fr')).toBeNull()
  })

  it('replaces the previous choice for the same site', () => {
    let memory = rememberFill({}, 'perso', 'tiime.fr', 'old')
    memory = rememberFill(memory, 'perso', 'tiime.fr', 'new')
    expect(lastFill(memory, 'perso', 'tiime.fr')).toBe('new')
    expect(Object.keys(memory.perso)).toHaveLength(1)
  })

  it('does not mutate the store it is given', () => {
    const before: FillMemory = {}
    rememberFill(before, 'perso', 'tiime.fr', 'item-9')
    expect(before).toEqual({})
  })

  it('ignores an incomplete write rather than storing an empty key', () => {
    expect(rememberFill({}, '', 'tiime.fr', 'x')).toEqual({})
    expect(rememberFill({}, 'perso', '', 'x')).toEqual({})
    expect(rememberFill({}, 'perso', 'tiime.fr', '')).toEqual({})
  })

  it('drops the oldest site over the cap, keeping the newest', () => {
    let memory: FillMemory = {}
    for (let i = 0; i < MAX_SITES_PER_PROFILE + 5; i++) {
      memory = rememberFill(memory, 'perso', `site-${i}.fr`, `item-${i}`)
    }
    expect(Object.keys(memory.perso)).toHaveLength(MAX_SITES_PER_PROFILE)
    expect(lastFill(memory, 'perso', 'site-0.fr')).toBeNull()
    expect(lastFill(memory, 'perso', `site-${MAX_SITES_PER_PROFILE + 4}.fr`)).toBe(
      `item-${MAX_SITES_PER_PROFILE + 4}`
    )
  })

  it('re-choosing an old site moves it back to the newest end', () => {
    let memory = rememberFill({}, 'perso', 'a.fr', 'x')
    memory = rememberFill(memory, 'perso', 'b.fr', 'y')
    memory = rememberFill(memory, 'perso', 'a.fr', 'x')
    expect(Object.keys(memory.perso)).toEqual(['b.fr', 'a.fr'])
  })

  it('forgets one profile whole, leaving the others', () => {
    let memory = rememberFill({}, 'perso', 'a.fr', 'x')
    memory = rememberFill(memory, 'pro', 'b.fr', 'y')
    const out = forgetFillProfile(memory, 'perso')
    expect(out.perso).toBeUndefined()
    expect(lastFill(out, 'pro', 'b.fr')).toBe('y')
  })

  it('returns the same store when there is nothing to forget', () => {
    const memory = rememberFill({}, 'perso', 'a.fr', 'x')
    expect(forgetFillProfile(memory, 'pro')).toBe(memory)
  })
})

describe('readFillMemory', () => {
  it('keeps well-formed entries', () => {
    expect(readFillMemory({ perso: { 'tiime.fr': 'item-9' } })).toEqual({
      perso: { 'tiime.fr': 'item-9' }
    })
  })

  it('drops garbage rather than throwing', () => {
    expect(readFillMemory(null)).toEqual({})
    expect(readFillMemory([1, 2])).toEqual({})
    expect(readFillMemory('nope')).toEqual({})
    expect(readFillMemory({ perso: 'nope' })).toEqual({})
    expect(readFillMemory({ perso: { 'tiime.fr': 42 } })).toEqual({})
    expect(readFillMemory({ perso: { '': 'item' } })).toEqual({})
  })
})

describe('the frame reports', () => {
  const report = (over: Record<string, unknown> = {}): unknown => ({
    token: 'fill-1',
    url: 'https://example.com/login',
    usernameFilled: true,
    passwordFilled: true,
    passwordFields: 1,
    ...over
  })

  it('reads a well-formed report', () => {
    expect(readFrameFillReport(report())).toEqual({
      token: 'fill-1',
      url: 'https://example.com/login',
      usernameFilled: true,
      passwordFilled: true,
      passwordFields: 1
    })
  })

  it('drops a report with no token: it cannot belong to any call', () => {
    expect(readFrameFillReport(report({ token: '' }))).toBeNull()
    expect(readFrameFillReport(report({ token: 7 }))).toBeNull()
    expect(readFrameFillReport(null)).toBeNull()
  })

  it('treats anything but true as not filled', () => {
    const out = readFrameFillReport(report({ usernameFilled: 'yes', passwordFilled: 1 }))
    expect(out).toMatchObject({ usernameFilled: false, passwordFilled: false })
  })

  it('merges what several frames did', () => {
    const merged = mergeFillReports([
      {
        token: 't',
        url: 'a',
        usernameFilled: false,
        passwordFilled: false,
        passwordFields: 0
      },
      { token: 't', url: 'b', usernameFilled: true, passwordFilled: true, passwordFields: 1 }
    ])
    expect(merged).toEqual({ username: true, password: true, frames: 1, passwordFields: 1 })
  })

  it('counts nothing when no frame had a form', () => {
    expect(mergeFillReports([])).toEqual({
      username: false,
      password: false,
      frames: 0,
      passwordFields: 0
    })
  })
})

describe('fillSite', () => {
  it('reduces a host to its site, which is what a choice is remembered against', () => {
    expect(fillSite('go.tiime.fr')).toBe('tiime.fr')
    expect(fillSite('eu.holistics.io')).toBe('holistics.io')
  })
})
