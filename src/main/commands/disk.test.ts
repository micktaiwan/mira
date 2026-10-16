import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'
import type { DiskUsageReport } from '../disk-usage'

describe('disk-usage command', () => {
  it('returns the report from the context', async () => {
    const { ctx } = makeContext()
    const res = await createCommandRegistry().execute('disk-usage', undefined, ctx)
    expect(res.ok).toBe(true)
    const usage = (res as unknown as { usage: DiskUsageReport }).usage
    expect(usage.root).toBe('/fake/userData')
    // The fake attributes one rollup row per profile in the list.
    const direct = await ctx.diskUsage()
    expect(usage.profiles.map((p) => p.id)).toEqual(direct.profiles.map((p) => p.id))
  })

  it('wraps a failed walk as a failed result', async () => {
    const { ctx } = makeContext()
    const boom = {
      ...ctx,
      diskUsage: async () => {
        throw new Error('nope')
      }
    }
    const res = await createCommandRegistry().execute('disk-usage', undefined, boom)
    expect(res).toEqual({ ok: false, error: 'nope' })
  })
})
