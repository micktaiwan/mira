import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'
import type { DiskUsageReport } from '../disk-usage'

describe('disk-usage command', () => {
  it('returns the report from the context', () => {
    const { ctx } = makeContext()
    const res = createCommandRegistry().execute('disk-usage', undefined, ctx)
    expect(res.ok).toBe(true)
    const usage = (res as unknown as { usage: DiskUsageReport }).usage
    expect(usage.root).toBe('/fake/userData')
    // The fake attributes one rollup row per profile in the list.
    expect(usage.profiles.map((p) => p.id)).toEqual(ctx.diskUsage().profiles.map((p) => p.id))
  })

  it('wraps a thrown error as a failed result', () => {
    const { ctx } = makeContext()
    const boom = {
      ...ctx,
      diskUsage: () => {
        throw new Error('nope')
      }
    }
    const res = createCommandRegistry().execute('disk-usage', undefined, boom)
    expect(res).toEqual({ ok: false, error: 'nope' })
  })
})
