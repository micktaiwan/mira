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
    // Pane sink: it opened the pane in loading, then filled it with the summary.
    expect(skillPaneStates).toEqual([
      { open: true, title: 'Summarize this page', status: 'loading' },
      {
        open: true,
        title: 'Summarize this page',
        status: 'done',
        text: 'summary(extracted:readability)'
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
