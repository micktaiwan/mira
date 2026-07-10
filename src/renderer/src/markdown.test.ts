import { describe, it, expect } from 'vitest'
import { parseInline, parseMarkdown } from './markdown'

describe('parseInline', () => {
  it('keeps plain text as a single span', () => {
    expect(parseInline('hello world')).toEqual([{ type: 'text', text: 'hello world' }])
  })

  it('parses bold, italic and code, with surrounding text', () => {
    expect(parseInline('a **b** c')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'bold', text: 'b' },
      { type: 'text', text: ' c' }
    ])
    expect(parseInline('_em_ and `code`')).toEqual([
      { type: 'italic', text: 'em' },
      { type: 'text', text: ' and ' },
      { type: 'code', text: 'code' }
    ])
  })

  it('prefers bold over italic for ** and treats ** inside code as literal', () => {
    expect(parseInline('**strong**')).toEqual([{ type: 'bold', text: 'strong' }])
    expect(parseInline('`a ** b`')).toEqual([{ type: 'code', text: 'a ** b' }])
  })

  it('parses a link into text + href', () => {
    expect(parseInline('see [docs](https://x.dev)')).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'link', text: 'docs', href: 'https://x.dev' }
    ])
  })
})

describe('parseMarkdown', () => {
  it('splits paragraphs on blank lines and joins wrapped lines with a space', () => {
    const blocks = parseMarkdown('First line\nstill first.\n\nSecond para.')
    expect(blocks).toEqual([
      { type: 'paragraph', spans: [{ type: 'text', text: 'First line still first.' }] },
      { type: 'paragraph', spans: [{ type: 'text', text: 'Second para.' }] }
    ])
  })

  it('parses headings with their level', () => {
    const blocks = parseMarkdown('# Title\n### Sub')
    expect(blocks).toEqual([
      { type: 'heading', level: 1, spans: [{ type: 'text', text: 'Title' }] },
      { type: 'heading', level: 3, spans: [{ type: 'text', text: 'Sub' }] }
    ])
  })

  it('groups consecutive bullets into one list, with inline markup per item', () => {
    const blocks = parseMarkdown('- **A** thing\n- B thing')
    expect(blocks).toEqual([
      {
        type: 'list',
        ordered: false,
        items: [
          [
            { type: 'bold', text: 'A' },
            { type: 'text', text: ' thing' }
          ],
          [{ type: 'text', text: 'B thing' }]
        ]
      }
    ])
  })

  it('separates an ordered list from a following bullet list', () => {
    const blocks = parseMarkdown('1. one\n2. two\n- bullet')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ type: 'list', ordered: true })
    expect(blocks[1]).toMatchObject({ type: 'list', ordered: false })
  })
})
