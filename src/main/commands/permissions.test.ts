import { describe, it, expect } from 'vitest'
import { createCommandRegistry, type PermissionGrant } from '.'
import { makeContext } from './fake-context'

const registry = createCommandRegistry()

describe('list-permissions', () => {
  it('returns the grant log, most-recent-first', () => {
    const { ctx } = makeContext()
    const res = registry.execute('list-permissions', {}, ctx)
    expect(res.ok).toBe(true)
    const grants = (res as unknown as { grants: PermissionGrant[] }).grants
    expect(grants.map((g) => `${g.origin} ${g.permission}`)).toEqual([
      'https://www.google.com geolocation',
      'https://news.test notifications'
    ])
  })
})

describe('clear-permissions', () => {
  it('empties the log and reports how many were removed', () => {
    const { ctx, permissions } = makeContext()
    expect(permissions()).toHaveLength(2)
    expect(registry.execute('clear-permissions', {}, ctx)).toEqual({ ok: true, cleared: 2 })
    expect(permissions()).toHaveLength(0)
    const res = registry.execute('list-permissions', {}, ctx)
    expect((res as unknown as { grants: PermissionGrant[] }).grants).toEqual([])
  })
})
