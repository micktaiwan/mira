import { describe, expect, it } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'
import { parseUploadParams } from './frames'

const registry = createCommandRegistry()
const yes = (): boolean => true

describe('parseUploadParams', () => {
  it('defaults to the first input[type=file] of the top document', () => {
    expect(parseUploadParams({ files: ['/tmp/a.pdf'] }, yes)).toEqual({
      files: ['/tmp/a.pdf'],
      timeoutMs: 5000,
      input: { selector: 'input[type=file]', nth: 1 }
    })
  })
  it('a click target answers the chooser, in the named frame', () => {
    const r = parseUploadParams(
      {
        files: ['/tmp/a.pdf'],
        frame: 'userCodeAppPanel',
        click: { text: 'Add receipt', nth: 2 },
        tabId: 't1'
      },
      yes
    )
    expect(r).toMatchObject({
      tabId: 't1',
      frame: { kind: 'match', value: 'userCodeAppPanel' },
      click: {
        target: { kind: 'text', value: 'Add receipt' },
        nth: 2,
        tabId: 't1',
        frame: { kind: 'match', value: 'userCodeAppPanel' }
      }
    })
    expect(r).not.toHaveProperty('input')
  })
  it('refuses relative or missing files, and click + selector together', () => {
    expect(parseUploadParams({ files: ['a.pdf'] }, yes)).toMatchObject({
      error: expect.stringContaining('absolute')
    })
    expect(parseUploadParams({ files: ['/nope'] }, () => false)).toMatchObject({
      error: 'no such file: /nope'
    })
    expect(parseUploadParams({ files: [] }, yes)).toHaveProperty('error')
    expect(
      parseUploadParams({ files: ['/a'], click: { text: 'x' }, selector: 'input' }, yes)
    ).toHaveProperty('error')
    expect(parseUploadParams({ files: ['/a'], click: {} }, yes)).toMatchObject({
      error: expect.stringMatching(/^click: /)
    })
    expect(parseUploadParams({ files: ['/a'], frame: '' }, yes)).toHaveProperty('error')
  })
})

describe('frames commands', () => {
  it('list-frames returns the tab frames', async () => {
    const fake = makeContext()
    const ctx = fake.ctx
    const res = (await registry.execute('list-frames', {}, ctx)) as {
      ok: boolean
      frames: unknown[]
    }
    expect(res.ok).toBe(true)
    expect(res.frames).toHaveLength(2)
    expect(await registry.execute('list-frames', { tabId: 'nope' }, ctx)).toMatchObject({
      ok: false
    })
  })

  it('upload-files hands the parsed request to the context', async () => {
    const fake = makeContext()
    const ctx = fake.ctx
    const res = await registry.execute(
      'upload-files',
      { files: [__filename], click: { selector: '#add' } },
      ctx
    )
    expect(res).toMatchObject({ ok: true, via: 'chooser' })
    expect(fake.uploads[0].click?.target).toEqual({ kind: 'selector', value: '#add' })
    expect(await registry.execute('upload-files', { files: ['rel.pdf'] }, ctx)).toMatchObject({
      ok: false
    })
  })

  it('exec-js, snapshot, type-text and wait-for pass the frame through', async () => {
    const fake = makeContext()
    const ctx = fake.ctx
    await registry.execute('exec-js', { code: '1', frame: 1 }, ctx)
    expect(fake.execJs.at(-1)).toMatchObject({ code: '1', frame: { kind: 'index', index: 1 } })
    await registry.execute('exec-js', { code: '2' }, ctx)
    expect(fake.execJs.at(-1)).not.toHaveProperty('frame')
    await registry.execute('snapshot', { frame: 'panel' }, ctx)
    expect(fake.execJs.at(-1)).toMatchObject({ frame: { kind: 'match', value: 'panel' } })
    await registry.execute('type-text', { ref: 3, text: 'hi', frame: 2 }, ctx)
    expect(fake.typings.at(-1)).toMatchObject({ ref: 3, frame: { kind: 'index', index: 2 } })
    expect(
      await registry.execute('type-text', { focused: true, text: 'hi', frame: 2 }, ctx)
    ).toMatchObject({ ok: false })
    await registry.execute('wait-for', { selector: 'button', frame: 'panel' }, ctx)
    expect(fake.waits.at(-1)).toMatchObject({ frame: { kind: 'match', value: 'panel' } })
    await registry.execute('click', { text: 'Add receipt', frame: 'panel' }, ctx)
    expect(fake.clicks.at(-1)).toMatchObject({ frame: { kind: 'match', value: 'panel' } })
    expect(await registry.execute('exec-js', { code: '1', frame: -2 }, ctx)).toMatchObject({
      ok: false
    })
  })
})
