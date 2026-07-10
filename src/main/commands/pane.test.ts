import { describe, it, expect } from 'vitest'
import { createCommandRegistry, type SkillPaneState } from '.'
import { makeContext } from './fake-context'

const registry = createCommandRegistry()

function pane(ctx: Parameters<typeof registry.execute>[2]): SkillPaneState {
  const res = registry.execute('get-skill-pane', {}, ctx)
  expect(res.ok).toBe(true)
  return (res as unknown as { pane: SkillPaneState }).pane
}

/** The assistant text of the last turn (the answer just produced). */
function lastAnswer(ctx: Parameters<typeof registry.execute>[2]): string | undefined {
  const msgs = pane(ctx).messages
  return msgs[msgs.length - 1]?.text
}

describe('skill pane commands', () => {
  it('starts closed and empty', () => {
    const { ctx } = makeContext()
    expect(pane(ctx)).toEqual({ open: false, title: '', status: 'idle', messages: [] })
  })

  it('keeps the conversation on close and brings it back on toggle', async () => {
    const { ctx } = makeContext()
    registry.execute('new-tab', { url: 'https://example.com/article' }, ctx)
    await registry.execute('run-skill', { id: 'summarize-page' }, ctx)
    expect(pane(ctx).open).toBe(true)
    // A skill posts a Q/A pair: the skill name, then its summary.
    expect(pane(ctx).messages).toEqual([
      { role: 'user', text: 'Summarize this page' },
      { role: 'assistant', text: 'summary(extracted:readability)' }
    ])

    // Close only hides it — the thread is retained.
    expect(registry.execute('close-skill-pane', {}, ctx)).toEqual({ ok: true, open: false })
    expect(pane(ctx).open).toBe(false)
    expect(lastAnswer(ctx)).toBe('summary(extracted:readability)')

    // Toggle shows the same conversation again.
    expect(registry.execute('toggle-skill-pane', {}, ctx)).toEqual({ ok: true, open: true })
    expect(pane(ctx).open).toBe(true)
    expect(pane(ctx).messages).toHaveLength(2)
  })

  it('toggle opens the pane even with nothing to show (for the prompt box)', () => {
    const { ctx } = makeContext()
    expect(registry.execute('toggle-skill-pane', {}, ctx)).toEqual({ ok: true, open: true })
    expect(pane(ctx).open).toBe(true)
    expect(pane(ctx).title).toBe('')
    expect(pane(ctx).messages).toEqual([])
    // And an explicit open:false closes it.
    expect(registry.execute('toggle-skill-pane', { open: false }, ctx)).toEqual({
      ok: true,
      open: false
    })
    expect(pane(ctx).open).toBe(false)
  })

  it('clear-chat empties the conversation but keeps the pane open', async () => {
    const { ctx } = makeContext()
    registry.execute('new-tab', { url: 'https://example.com/article' }, ctx)
    await registry.execute('run-skill', { id: 'summarize-page' }, ctx)
    expect(pane(ctx).messages).toHaveLength(2)

    expect(registry.execute('clear-chat', {}, ctx)).toEqual({ ok: true, cleared: true })
    expect(pane(ctx).open).toBe(true)
    expect(pane(ctx).messages).toEqual([])
    expect(pane(ctx).status).toBe('idle')
  })
})
