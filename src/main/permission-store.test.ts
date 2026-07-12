import { describe, it, expect } from 'vitest'
import {
  recordGrant,
  listGrants,
  normalizePermissions,
  MAX_PERMISSIONS,
  type PermissionGrant
} from './permission-store'

describe('recordGrant', () => {
  it('prepends a new (origin, permission) pair', () => {
    const list = recordGrant([], { origin: 'https://a.com', permission: 'geolocation', at: 10 })
    expect(list).toEqual([
      {
        origin: 'https://a.com',
        permission: 'geolocation',
        firstGranted: 10,
        lastGranted: 10,
        count: 1
      }
    ])
  })

  it('bumps count and lastGranted (keeps firstGranted) on a re-grant, moving it to front', () => {
    let list: PermissionGrant[] = []
    list = recordGrant(list, { origin: 'https://a.com', permission: 'geolocation', at: 10 })
    list = recordGrant(list, { origin: 'https://b.com', permission: 'notifications', at: 20 })
    list = recordGrant(list, { origin: 'https://a.com', permission: 'geolocation', at: 30 })
    expect(list).toEqual([
      {
        origin: 'https://a.com',
        permission: 'geolocation',
        firstGranted: 10,
        lastGranted: 30,
        count: 2
      },
      {
        origin: 'https://b.com',
        permission: 'notifications',
        firstGranted: 20,
        lastGranted: 20,
        count: 1
      }
    ])
  })

  it('treats same origin with a different permission as a distinct entry', () => {
    let list: PermissionGrant[] = []
    list = recordGrant(list, { origin: 'https://a.com', permission: 'geolocation', at: 10 })
    list = recordGrant(list, { origin: 'https://a.com', permission: 'notifications', at: 20 })
    expect(list).toHaveLength(2)
  })

  it('does not mutate the input list', () => {
    const before: PermissionGrant[] = []
    recordGrant(before, { origin: 'https://a.com', permission: 'geolocation', at: 10 })
    expect(before).toEqual([])
  })

  it('trims to MAX_PERMISSIONS from the tail (oldest)', () => {
    let list: PermissionGrant[] = []
    for (let i = 0; i < MAX_PERMISSIONS + 5; i++) {
      list = recordGrant(list, { origin: `https://${i}.com`, permission: 'geolocation', at: i })
    }
    expect(list).toHaveLength(MAX_PERMISSIONS)
    // The most-recent grant is at the front.
    expect(list[0].origin).toBe(`https://${MAX_PERMISSIONS + 4}.com`)
  })
})

describe('listGrants', () => {
  it('returns a copy in stored (most-recent-first) order', () => {
    const list = recordGrant([], { origin: 'https://a.com', permission: 'geolocation', at: 10 })
    const out = listGrants(list)
    expect(out).toEqual(list)
    expect(out).not.toBe(list)
  })
})

describe('normalizePermissions', () => {
  it('degrades non-array / bad input to an empty list', () => {
    expect(normalizePermissions(undefined)).toEqual([])
    expect(normalizePermissions(null)).toEqual([])
    expect(normalizePermissions('nope')).toEqual([])
  })

  it('drops entries missing origin or permission', () => {
    const raw = [
      { permission: 'geolocation', lastGranted: 1 },
      { origin: 'https://a.com', lastGranted: 1 },
      {
        origin: 'https://b.com',
        permission: 'geolocation',
        lastGranted: 5,
        firstGranted: 3,
        count: 2
      }
    ]
    expect(normalizePermissions(raw)).toEqual([
      {
        origin: 'https://b.com',
        permission: 'geolocation',
        firstGranted: 3,
        lastGranted: 5,
        count: 2
      }
    ])
  })

  it('drops duplicate (origin, permission) pairs, first wins', () => {
    const raw = [
      { origin: 'https://a.com', permission: 'geolocation', lastGranted: 5 },
      { origin: 'https://a.com', permission: 'geolocation', lastGranted: 9 }
    ]
    const out = normalizePermissions(raw)
    expect(out).toHaveLength(1)
    expect(out[0].lastGranted).toBe(5)
  })

  it('defaults firstGranted to lastGranted and count to 1 when absent', () => {
    const out = normalizePermissions([
      { origin: 'https://a.com', permission: 'geolocation', lastGranted: 7 }
    ])
    expect(out[0]).toEqual({
      origin: 'https://a.com',
      permission: 'geolocation',
      firstGranted: 7,
      lastGranted: 7,
      count: 1
    })
  })
})
