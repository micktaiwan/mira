import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'
import { DEFAULT_TRACE_CATEGORIES, DEFAULT_TRACE_BUFFER_KB } from '../tracing'

const registry = createCommandRegistry()

describe('start-tracing', () => {
  it('starts with the stall-hunting defaults and echoes what it got', async () => {
    const { ctx, tracing } = makeContext()
    const res = await registry.execute('start-tracing', undefined, ctx)
    expect(res).toEqual({
      ok: true,
      tracing: {
        categories: [...DEFAULT_TRACE_CATEGORIES],
        bufferKb: DEFAULT_TRACE_BUFFER_KB,
        mode: 'record-continuously'
      }
    })
    expect(tracing().active).toBe(true)
  })

  it('honours explicit categories, buffer and mode', async () => {
    const { ctx, tracing } = makeContext()
    const res = await registry.execute(
      'start-tracing',
      { categories: ['ipc', 'mojom'], bufferKb: 20_000, mode: 'record-until-full' },
      ctx
    )
    expect(res).toEqual({
      ok: true,
      tracing: { categories: ['ipc', 'mojom'], bufferKb: 20_000, mode: 'record-until-full' }
    })
    expect(tracing().starts).toHaveLength(1)
  })

  it('reports a bad param as a failed result, and starts nothing', async () => {
    const { ctx, tracing } = makeContext()
    const res = await registry.execute('start-tracing', { bufferKb: -1 }, ctx)
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toMatch(/bufferKb/)
    expect(tracing().active).toBe(false)
  })

  it('refuses a second recording rather than silently doing nothing', async () => {
    const { ctx } = makeContext()
    await registry.execute('start-tracing', undefined, ctx)
    expect(await registry.execute('start-tracing', undefined, ctx)).toEqual({
      ok: false,
      error: 'a trace recording is already running'
    })
  })
})

describe('stop-tracing', () => {
  it('returns the written trace path and clears the session', async () => {
    const { ctx, tracing } = makeContext()
    await registry.execute('start-tracing', undefined, ctx)
    const res = await registry.execute('stop-tracing', undefined, ctx)
    expect(res).toEqual({
      ok: true,
      path: '/fake/userData/traces/trace-2026-08-05T10-45-14.json'
    })
    expect(tracing().active).toBe(false)
  })

  it('fails when nothing is recording', async () => {
    const { ctx } = makeContext()
    expect(await registry.execute('stop-tracing', undefined, ctx)).toEqual({
      ok: false,
      error: 'no trace recording is running'
    })
  })

  it('can start again after a stop', async () => {
    const { ctx, tracing } = makeContext()
    await registry.execute('start-tracing', undefined, ctx)
    await registry.execute('stop-tracing', undefined, ctx)
    expect((await registry.execute('start-tracing', undefined, ctx)).ok).toBe(true)
    expect(tracing().starts).toHaveLength(2)
  })
})

describe('tracing-status', () => {
  it('tracks whether a recording is running', async () => {
    const { ctx } = makeContext()
    expect(registry.execute('tracing-status', undefined, ctx)).toEqual({ ok: true, active: false })
    await registry.execute('start-tracing', undefined, ctx)
    expect(registry.execute('tracing-status', undefined, ctx)).toEqual({ ok: true, active: true })
  })
})

describe('tracing-categories', () => {
  it('lists what the running build offers', async () => {
    const { ctx } = makeContext()
    expect(await registry.execute('tracing-categories', undefined, ctx)).toEqual({
      ok: true,
      categories: ['toplevel', 'ipc', 'mojom']
    })
  })
})
