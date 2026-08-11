import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'
import type { ScreenshotResult } from '../screenshot'

const registry = createCommandRegistry()

/** Await the registry's result: this handler is async (the capture and the file
 * write are), and `execute` is typed synchronously for the many sync callers. */
async function shoot(params: unknown): Promise<ScreenshotResult & { ok: boolean; error?: string }> {
  const fake = makeContext()
  const res = await (registry.execute('screenshot', params, fake.ctx) as unknown as Promise<
    ScreenshotResult & { ok: boolean; error?: string }
  >)
  return res
}

describe('screenshot command', () => {
  it('captures the active tab into the default directory', async () => {
    const res = await shoot({})
    expect(res.ok).toBe(true)
    expect(res.path).toBe('/fake/userData/screenshots/shot-2026-08-11T09-30-00.png')
    expect(res.fullPage).toBe(false)
    expect(res.bytes).toBeGreaterThan(0)
  })

  it('writes where the caller asked', async () => {
    const res = await shoot({ path: '/tmp/cgm.png' })
    expect(res.ok).toBe(true)
    expect(res.path).toBe('/tmp/cgm.png')
  })

  it('passes the target tab and the fullPage flag through', async () => {
    const fake = makeContext()
    await (registry.execute(
      'screenshot',
      { tabId: 'tab-2', fullPage: true },
      fake.ctx
    ) as unknown as Promise<unknown>)
    expect(fake.screenshots).toEqual([{ tabId: 'tab-2', fullPage: true }])
  })

  it('reports a bad path as a failed command, not a thrown error', async () => {
    const res = await shoot({ path: 'shot.png' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/absolute/)
  })

  it('refuses an extension that would lie about the format', async () => {
    const res = await shoot({ path: '/tmp/shot.jpg' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/\.png/)
  })

  it('is listed by list-commands', () => {
    const fake = makeContext()
    const res = registry.execute('list-commands', {}, fake.ctx) as {
      ok: boolean
      commands: string[]
    }
    expect(res.commands).toContain('screenshot')
  })
})
