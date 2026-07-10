import { describe, it, expect } from 'vitest'
import {
  resolveSkills,
  extractionScript,
  extractiveSummary,
  BUILTIN_SKILLS,
  type Skill
} from './skills'

describe('resolveSkills', () => {
  it('offers the generic summarize-page skill on any http(s) page', () => {
    const ids = resolveSkills('https://example.com/article').map((s) => s.id)
    expect(ids).toContain('summarize-page')
  })

  it('offers no skills on non-web urls (settings, about:blank, empty)', () => {
    expect(resolveSkills('mira://settings')).toEqual([])
    expect(resolveSkills('about:blank')).toEqual([])
    expect(resolveSkills('')).toEqual([])
    expect(resolveSkills('not a url')).toEqual([])
  })

  it('restricts a hosted skill to its domain and subdomains', () => {
    const gmail: Skill = {
      id: 'summarize-email',
      name: 'Summarize this email',
      match: { host: 'mail.google.com' },
      prompt: '',
      source: { kind: 'selector', selector: '.email' },
      sink: { kind: 'pane' }
    }
    const skills = [gmail, ...BUILTIN_SKILLS]
    // On Gmail: both the hosted skill and the generic one.
    const onGmail = resolveSkills('https://mail.google.com/mail/u/0/#inbox', skills).map(
      (s) => s.id
    )
    expect(onGmail).toContain('summarize-email')
    expect(onGmail).toContain('summarize-page')
    // Elsewhere: only the generic one.
    const elsewhere = resolveSkills('https://example.com', skills).map((s) => s.id)
    expect(elsewhere).not.toContain('summarize-email')
    expect(elsewhere).toContain('summarize-page')
  })

  it('matches a subdomain of a hosted skill but not a lookalike domain', () => {
    const skill: Skill = {
      id: 'x',
      name: 'x',
      match: { host: 'google.com' },
      prompt: '',
      source: { kind: 'raw' },
      sink: { kind: 'pane' }
    }
    expect(resolveSkills('https://mail.google.com', [skill]).map((s) => s.id)).toEqual(['x'])
    expect(resolveSkills('https://google.com', [skill]).map((s) => s.id)).toEqual(['x'])
    // notgoogle.com must NOT match (endsWith '.google.com' guards this).
    expect(resolveSkills('https://notgoogle.com', [skill])).toEqual([])
  })
})

describe('extractionScript', () => {
  it('targets a specific element for a selector source, safely escaping it', () => {
    const script = extractionScript({ kind: 'selector', selector: 'div[data-id="a\'b"]' })
    // The selector is JSON-escaped so a quote in it cannot break out of the string.
    expect(script).toContain(JSON.stringify('div[data-id="a\'b"]'))
    expect(script).toContain('querySelector')
  })

  it('reads the main content region for a readability source', () => {
    const script = extractionScript({ kind: 'readability' })
    expect(script).toContain('article, main, [role="main"]')
    expect(script).toContain('document.body')
  })

  it('reads the whole body for a raw source', () => {
    expect(extractionScript({ kind: 'raw' })).toContain('document.body.innerText')
  })
})

describe('extractiveSummary', () => {
  it('returns short text unchanged (only whitespace collapsed)', () => {
    expect(extractiveSummary('  Hello   world.  ')).toBe('Hello world.')
  })

  it('keeps whole lead sentences up to the budget, not a mid-sentence cut', () => {
    const text = 'First sentence here. Second one follows. Third is extra padding to overflow.'
    const out = extractiveSummary(text, 40)
    // Stops at a sentence boundary within budget — no dangling half sentence.
    expect(out).toBe('First sentence here. Second one follows.')
  })

  it('falls back to a hard slice when there is no sentence boundary', () => {
    const text = 'a'.repeat(100)
    expect(extractiveSummary(text, 10)).toBe('a'.repeat(10))
  })
})
