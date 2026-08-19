import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

const registry = createCommandRegistry()
type Ctx = Parameters<typeof registry.execute>[2]

async function run(
  ctx: Ctx,
  name: string,
  params?: unknown
): Promise<{ ok: boolean; [k: string]: unknown }> {
  return (await registry.execute(name, params ?? {}, ctx)) as { ok: boolean; [k: string]: unknown }
}

const SPI = {
  url: 'https://cfspart.impots.gouv.fr/LoginAccess',
  field: 'spi',
  value: '0970773949166'
}

describe('remember-form-value / suggest-form-values', () => {
  it('remembers a typed value and offers it back on the site', async () => {
    const { ctx } = makeContext()
    expect(await run(ctx, 'remember-form-value', SPI)).toMatchObject({
      ok: true,
      domain: 'impots.gouv.fr',
      field: 'spi',
      remembered: true
    })
    expect(await run(ctx, 'suggest-form-values', { url: SPI.url, field: 'spi' })).toMatchObject({
      ok: true,
      values: ['0970773949166']
    })
  })

  it('offers nothing on another site', async () => {
    const { ctx } = makeContext()
    await run(ctx, 'remember-form-value', SPI)
    expect(
      await run(ctx, 'suggest-form-values', { url: 'https://www.ameli.fr/', field: 'spi' })
    ).toMatchObject({ values: [] })
  })

  it('offers nothing to another profile', async () => {
    const { ctx } = makeContext()
    await run(ctx, 'remember-form-value', { ...SPI, profileId: 'perso' })
    expect(
      await run(ctx, 'suggest-form-values', { url: SPI.url, field: 'spi', profileId: 'pro' })
    ).toMatchObject({ values: [] })
  })

  it('refuses a password field and a card number', async () => {
    const { ctx } = makeContext()
    expect(
      await run(ctx, 'remember-form-value', { url: SPI.url, field: 'password', value: 'hunter2' })
    ).toMatchObject({ remembered: false })
    expect(
      await run(ctx, 'remember-form-value', {
        url: SPI.url,
        field: 'reference',
        value: '4242 4242 4242 4242'
      })
    ).toMatchObject({ remembered: false })
  })

  it('needs a url, a field and a value', async () => {
    const { ctx } = makeContext()
    expect(await run(ctx, 'remember-form-value', { field: 'spi', value: 'x' })).toMatchObject({
      ok: false
    })
    expect(await run(ctx, 'remember-form-value', { url: SPI.url, value: 'x' })).toMatchObject({
      ok: false
    })
    expect(await run(ctx, 'suggest-form-values', { url: SPI.url })).toMatchObject({ ok: false })
  })
})

describe('list-form-memory', () => {
  it('starts empty', async () => {
    const { ctx } = makeContext()
    expect(await run(ctx, 'list-form-memory')).toEqual({ ok: true, entries: [] })
  })

  it('lists what was remembered, and narrows by site', async () => {
    const { ctx } = makeContext()
    await run(ctx, 'remember-form-value', SPI)
    await run(ctx, 'remember-form-value', {
      url: 'https://www.ameli.fr/',
      field: 'nir',
      value: '1800675123456'
    })
    expect((await run(ctx, 'list-form-memory')).entries).toHaveLength(2)
    expect(
      (await run(ctx, 'list-form-memory', { domain: 'impots.gouv.fr' })).entries
    ).toMatchObject([
      { domain: 'impots.gouv.fr', field: 'spi', values: [{ value: '0970773949166', count: 1 }] }
    ])
  })
})

describe('forget-form-memory', () => {
  it('forgets one value', async () => {
    const { ctx } = makeContext()
    await run(ctx, 'remember-form-value', SPI)
    expect(
      await run(ctx, 'forget-form-memory', {
        domain: 'impots.gouv.fr',
        field: 'spi',
        value: SPI.value
      })
    ).toMatchObject({ ok: true, removed: 1 })
    expect((await run(ctx, 'list-form-memory')).entries).toEqual([])
  })

  it('forgets a whole site, leaving the others', async () => {
    const { ctx } = makeContext()
    await run(ctx, 'remember-form-value', SPI)
    await run(ctx, 'remember-form-value', {
      url: 'https://www.ameli.fr/',
      field: 'nir',
      value: '1800675123456'
    })
    expect(
      await run(ctx, 'forget-form-memory', { domain: 'https://cfspart.impots.gouv.fr/x' })
    ).toMatchObject({ removed: 1 })
    expect((await run(ctx, 'list-form-memory')).entries).toMatchObject([{ domain: 'ameli.fr' }])
  })

  it('forgets everything a profile typed when nothing narrower is named', async () => {
    const { ctx } = makeContext()
    await run(ctx, 'remember-form-value', SPI)
    await run(ctx, 'remember-form-value', {
      url: 'https://www.ameli.fr/',
      field: 'nir',
      value: '1800675123456'
    })
    expect(await run(ctx, 'forget-form-memory', {})).toMatchObject({ removed: 2 })
    expect((await run(ctx, 'list-form-memory')).entries).toEqual([])
  })
})
