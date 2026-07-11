import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

const registry = createCommandRegistry()

describe('list-skills', () => {
  it('offers the generic summarizer on a web page', () => {
    const { ctx } = makeContext()
    registry.execute('new-tab', { url: 'https://example.com/article' }, ctx)
    const res = registry.execute('list-skills', {}, ctx) as {
      ok: true
      url: string | null
      skills: Array<{ id: string; name: string }>
    }
    expect(res.ok).toBe(true)
    expect(res.url).toBe('https://example.com/article')
    expect(res.skills.map((s) => s.id)).toContain('summarize-page')
  })

  it('offers no skills when there is no web page (fresh non-http tab)', () => {
    const { ctx } = makeContext()
    // The fake's first tab loads 'home' (a non-http url) → no skills.
    const res = registry.execute('list-skills', {}, ctx) as { ok: true; skills: unknown[] }
    expect(res.skills).toEqual([])
  })
})

describe('run-skill', () => {
  it('rejects a missing id', async () => {
    const { ctx } = makeContext()
    expect(await registry.execute('run-skill', {}, ctx)).toEqual({
      ok: false,
      error: 'missing "id"'
    })
  })

  it('rejects a skill that does not apply to the current page', async () => {
    const { ctx } = makeContext()
    registry.execute('new-tab', { url: 'https://example.com' }, ctx)
    const res = await registry.execute('run-skill', { id: 'no-such-skill' }, ctx)
    expect(res).toEqual({ ok: false, error: 'skill not applicable here: no-such-skill' })
  })

  it('extracts the skill source, runs the engine, and returns the summary', async () => {
    const { ctx, extractCalls, summarizeCalls, skillPaneStates } = makeContext()
    registry.execute('new-tab', { url: 'https://example.com/article' }, ctx)
    const res = (await registry.execute('run-skill', { id: 'summarize-page' }, ctx)) as {
      ok: true
      skill: string
      sink: string
      summary: string
    }
    expect(res.ok).toBe(true)
    expect(res.skill).toBe('summarize-page')
    expect(res.sink).toBe('pane')
    // The command extracted with the skill's source (readability) and fed that
    // text to the engine with the skill's prompt.
    expect(extractCalls).toEqual([{ kind: 'readability' }])
    expect(summarizeCalls).toHaveLength(1)
    expect(summarizeCalls[0].text).toBe('extracted:readability')
    expect(summarizeCalls[0].prompt).toContain('Summarize')
    expect(res.summary).toBe('summary(extracted:readability)')
    // Pane sink: it opened the pane in loading with the question turn, then added
    // the summary as the assistant turn (a chat Q/A pair).
    expect(skillPaneStates).toEqual([
      {
        open: true,
        title: 'Summarize this page',
        status: 'loading',
        messages: [{ role: 'user', text: 'Summarize this page' }]
      },
      {
        open: true,
        title: 'Summarize this page',
        status: 'idle',
        messages: [
          { role: 'user', text: 'Summarize this page' },
          { role: 'assistant', text: 'summary(extracted:readability)' }
        ]
      }
    ])
  })

  it('reports empty page content instead of summarizing nothing (and shows it in the pane)', async () => {
    const { ctx, skillPaneStates } = makeContext('default', { emptyExtract: true })
    registry.execute('new-tab', { url: 'https://example.com/blank' }, ctx)
    const res = await registry.execute('run-skill', { id: 'summarize-page' }, ctx)
    expect(res).toEqual({ ok: false, error: 'no page content to summarize' })
    // The pane went loading → error, never showing a bogus summary.
    expect(skillPaneStates.map((s) => s.status)).toEqual(['loading', 'error'])
    expect(skillPaneStates[1].error).toBe('no page content to summarize')
  })
})

describe('run-prompt', () => {
  it('rejects an empty prompt', async () => {
    const { ctx } = makeContext()
    expect(await registry.execute('run-prompt', { prompt: '  ' }, ctx)).toEqual({
      ok: false,
      error: 'missing "prompt"'
    })
  })

  it('appends the question, answers with the page text, and shows the thread', async () => {
    const { ctx, chatCalls, skillPaneStates } = makeContext()
    registry.execute('new-tab', { url: 'https://example.com/article' }, ctx)
    const res = (await registry.execute(
      'run-prompt',
      { prompt: 'What is the deadline?' },
      ctx
    )) as { ok: true; text: string }
    expect(res.ok).toBe(true)
    // The engine got the thread (this one turn) and the page context: URL + text.
    expect(chatCalls[0]).toEqual({
      messages: [{ role: 'user', text: 'What is the deadline?' }],
      page: { url: 'https://example.com/article', text: 'extracted:readability' }
    })
    expect(res.text).toBe(
      'answer(What is the deadline?|https://example.com/article|extracted:readability)'
    )
    // Pane opened loading (question only) then idle (question + answer).
    expect(skillPaneStates.map((s) => s.status)).toEqual(['loading', 'idle'])
    expect(skillPaneStates[0].title).toBe('What is the deadline?')
    expect(skillPaneStates[1].messages).toEqual([
      { role: 'user', text: 'What is the deadline?' },
      {
        role: 'assistant',
        text: 'answer(What is the deadline?|https://example.com/article|extracted:readability)'
      }
    ])
  })

  it('carries prior turns as history across a second prompt', async () => {
    const { ctx, chatCalls } = makeContext()
    registry.execute('new-tab', { url: 'https://example.com/article' }, ctx)
    await registry.execute('run-prompt', { prompt: 'First?' }, ctx)
    await registry.execute('run-prompt', { prompt: 'And then?' }, ctx)
    // The second turn's thread includes the first Q/A plus the new question, so
    // the model keeps context — this is the "vrai chat avec historique".
    expect(chatCalls[1].messages).toEqual([
      { role: 'user', text: 'First?' },
      {
        role: 'assistant',
        text: 'answer(First?|https://example.com/article|extracted:readability)'
      },
      { role: 'user', text: 'And then?' }
    ])
  })

  it('still answers when the page yields no text (plain question)', async () => {
    const { ctx, chatCalls } = makeContext('default', { emptyExtract: true })
    registry.execute('new-tab', { url: 'https://example.com/blank' }, ctx)
    const res = (await registry.execute('run-prompt', { prompt: 'Hi' }, ctx)) as {
      ok: true
      text: string
    }
    expect(res.ok).toBe(true)
    expect(chatCalls[0]).toEqual({
      messages: [{ role: 'user', text: 'Hi' }],
      page: { url: 'https://example.com/blank', text: '' }
    })
  })

  it('includes the page URL in the context even when text is present', async () => {
    const { ctx, chatCalls } = makeContext()
    registry.execute('new-tab', { url: 'https://maps.google.com/place/Ajaccio' }, ctx)
    await registry.execute('run-prompt', { prompt: 'Where am I?' }, ctx)
    // The assistant can no longer be blind to which page it is on.
    expect(chatCalls[0].page.url).toBe('https://maps.google.com/place/Ajaccio')
  })

  it('attaches a screenshot only when asked (📷), never by default', async () => {
    const { ctx, chatCalls, captureCalls } = makeContext()
    registry.execute('new-tab', { url: 'https://maps.google.com/place/Ajaccio' }, ctx)
    // Plain question: no capture, no image in the page context.
    await registry.execute('run-prompt', { prompt: 'Where?' }, ctx)
    expect(captureCalls).toHaveLength(0)
    expect(chatCalls[0].page.screenshot).toBeUndefined()
    // 📷: capture once and the image rides along with the turn.
    await registry.execute('run-prompt', { prompt: 'What do you see?', withScreenshot: true }, ctx)
    expect(captureCalls).toHaveLength(1)
    expect(chatCalls[1].page.screenshot).toBe('data:image/png;base64,ZmFrZQ==')
  })
})
