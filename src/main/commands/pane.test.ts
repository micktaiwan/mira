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

  it('copy-chat writes the latest assistant answer to the clipboard', async () => {
    const { ctx, clipboardWrites } = makeContext()
    registry.execute('new-tab', { url: 'https://example.com/article' }, ctx)
    await registry.execute('run-skill', { id: 'summarize-page' }, ctx)
    expect(registry.execute('copy-chat', {}, ctx)).toEqual({
      ok: true,
      length: 'summary(extracted:readability)'.length
    })
    expect(clipboardWrites).toEqual(['summary(extracted:readability)'])
  })

  it('copy-chat reports nothing to copy on an empty thread', () => {
    const { ctx } = makeContext()
    expect(registry.execute('copy-chat', {}, ctx)).toEqual({ ok: false, error: 'nothing to copy' })
  })

  it('set-chat-options merges model + MCP into the llm config, keeping provider/apiKey', () => {
    const { ctx, llm } = makeContext()
    // Start from an API config with a key, to prove the merge preserves it.
    registry.execute('set-llm-config', { provider: 'anthropic-api', apiKey: 'sk-x' }, ctx)

    expect(registry.execute('set-chat-options', { model: 'claude-opus-4-8', loadMcp: true }, ctx)) //
      .toEqual({ ok: true, model: 'claude-opus-4-8', loadMcp: true })
    expect(llm()).toEqual({
      provider: 'anthropic-api',
      apiKey: 'sk-x',
      model: 'claude-opus-4-8',
      loadMcp: true
    })

    // A partial change touches only what it names (model stays put when only MCP flips).
    registry.execute('set-chat-options', { loadMcp: false }, ctx)
    expect(llm()).toMatchObject({ model: 'claude-opus-4-8', loadMcp: false })

    // An empty model clears the override (back to the provider's default).
    expect(registry.execute('set-chat-options', { model: '' }, ctx)).toEqual({
      ok: true,
      model: '',
      loadMcp: false
    })
    expect(llm().model).toBeUndefined()
  })

  it('set-chat-options rejects a non-string model / non-boolean loadMcp', () => {
    const { ctx } = makeContext()
    expect(registry.execute('set-chat-options', { model: 5 }, ctx)).toEqual({
      ok: false,
      error: '"model" must be a string'
    })
    expect(registry.execute('set-chat-options', { loadMcp: 'yes' }, ctx)).toEqual({
      ok: false,
      error: '"loadMcp" must be a boolean'
    })
  })
})
