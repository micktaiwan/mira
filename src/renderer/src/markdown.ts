// A tiny, SAFE markdown parser for the skill pane. It parses to a plain AST (not
// HTML), which the Markdown component maps to React elements — so untrusted
// content (a web page summarized by the LLM) can never inject markup or script
// (no dangerouslySetInnerHTML anywhere). Pure and unit-tested, per the "tout
// testable" principle in CLAUDE.md.
//
// Supported subset — enough for AI summaries: headings (#..######), bullet and
// ordered lists, paragraphs, and inline **bold**, *italic* / _italic_, `code`,
// and [text](url) links. Anything fancier degrades to plain text.

/** An inline span within a block. */
export type Inline =
  | { type: 'text'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'italic'; text: string }
  | { type: 'code'; text: string }
  | { type: 'link'; text: string; href: string }

/** A block-level element. */
export type Block =
  | { type: 'heading'; level: number; spans: Inline[] }
  | { type: 'paragraph'; spans: Inline[] }
  | { type: 'list'; ordered: boolean; items: Inline[][] }

/** The inline patterns, tried in this order so a more specific / higher-priority
 * marker wins at the same position (code before emphasis so `**` inside code is
 * literal; bold before italic so `**x**` is bold, not two italics). */
const INLINE_PATTERNS: Array<{ type: Inline['type']; re: RegExp }> = [
  { type: 'code', re: /`([^`]+)`/ },
  { type: 'link', re: /\[([^\]]+)\]\(([^)]+)\)/ },
  { type: 'bold', re: /\*\*([^*]+)\*\*|__([^_]+)__/ },
  { type: 'italic', re: /\*([^*]+)\*|_([^_]+)_/ }
]

/** Parse a single line's inline markup into spans. */
export function parseInline(input: string): Inline[] {
  const spans: Inline[] = []
  let rest = input
  while (rest !== '') {
    // Find the earliest-starting marker among all patterns.
    let best: { type: Inline['type']; m: RegExpMatchArray; index: number } | null = null
    for (const { type, re } of INLINE_PATTERNS) {
      const m = re.exec(rest)
      if (m && (best === null || m.index < best.index)) best = { type, m, index: m.index }
    }
    if (!best) {
      spans.push({ type: 'text', text: rest })
      break
    }
    // Emit any plain text before the marker.
    if (best.index > 0) spans.push({ type: 'text', text: rest.slice(0, best.index) })
    const g = best.m
    if (best.type === 'link') {
      spans.push({ type: 'link', text: g[1], href: g[2] })
    } else if (best.type === 'code') {
      spans.push({ type: 'code', text: g[1] })
    } else {
      // bold / italic each have two alternation groups (*/_): take whichever matched.
      spans.push({ type: best.type, text: g[1] ?? g[2] })
    }
    rest = rest.slice(best.index + g[0].length)
  }
  return spans
}

const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^\s*[-*]\s+(.*)$/
const ORDERED = /^\s*\d+\.\s+(.*)$/

/** Parse markdown text into a block list. Blank lines separate blocks; runs of
 * list items of the same kind group into one list; other non-blank lines join
 * into a paragraph (a single newline is a space, as in markdown). */
export function parseMarkdown(input: string): Block[] {
  const blocks: Block[] = []
  const lines = input.replace(/\r\n/g, '\n').split('\n')
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null

  const flushParagraph = (): void => {
    if (paragraph.length) {
      blocks.push({ type: 'paragraph', spans: parseInline(paragraph.join(' ')) })
      paragraph = []
    }
  }
  const flushList = (): void => {
    if (list) {
      blocks.push({
        type: 'list',
        ordered: list.ordered,
        items: list.items.map((it) => parseInline(it))
      })
      list = null
    }
  }

  for (const line of lines) {
    if (line.trim() === '') {
      flushParagraph()
      flushList()
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      flushParagraph()
      flushList()
      blocks.push({ type: 'heading', level: heading[1].length, spans: parseInline(heading[2]) })
      continue
    }
    const bullet = BULLET.exec(line)
    const ordered = ORDERED.exec(line)
    if (bullet || ordered) {
      flushParagraph()
      const isOrdered = ordered !== null
      const text = (bullet ?? ordered)![1]
      // A change of list kind starts a new list.
      if (list && list.ordered !== isOrdered) flushList()
      if (!list) list = { ordered: isOrdered, items: [] }
      list.items.push(text)
      continue
    }
    // Plain text line: part of a paragraph (ends any open list).
    flushList()
    paragraph.push(line)
  }
  flushParagraph()
  flushList()
  return blocks
}
