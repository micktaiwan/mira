import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

const registry = createCommandRegistry()

describe('exec-js', () => {
  it('runs the code in the active tab and returns its result', async () => {
    const { ctx, execJs } = makeContext()
    const res = await registry.execute('exec-js', { code: 'document.title' }, ctx)
    expect(res).toEqual({ ok: true, result: 'ran:document.title' })
    expect(execJs).toEqual(['document.title'])
  })

  it('rejects an empty or missing code', async () => {
    const { ctx } = makeContext()
    expect(await registry.execute('exec-js', {}, ctx)).toEqual({
      ok: false,
      error: 'missing "code"'
    })
    expect(await registry.execute('exec-js', { code: '   ' }, ctx)).toEqual({
      ok: false,
      error: 'missing "code"'
    })
  })
})
