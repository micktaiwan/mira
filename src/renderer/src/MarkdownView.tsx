import { parseMarkdown, type Inline } from './markdown'

// Render markdown as React elements (never innerHTML), so a summary of an
// untrusted page can carry no markup or script into the chrome. The parsing is
// pure and tested (markdown.ts); this is just the element mapping.

/** Render one line's inline spans. Links open through the command bus so they
 * land in a Mira tab, not by navigating the chrome itself. */
function renderInline(spans: Inline[]): React.ReactNode {
  return spans.map((s, i) => {
    switch (s.type) {
      case 'bold':
        return <strong key={i}>{s.text}</strong>
      case 'italic':
        return <em key={i}>{s.text}</em>
      case 'code':
        return <code key={i}>{s.text}</code>
      case 'link':
        return (
          <a
            key={i}
            href={s.href}
            onClick={(e) => {
              e.preventDefault()
              void window.mira.command('navigate', { url: s.href, newTab: true })
            }}
          >
            {s.text}
          </a>
        )
      default:
        return <span key={i}>{s.text}</span>
    }
  })
}

function MarkdownView({ text }: { text: string }): React.JSX.Element {
  const blocks = parseMarkdown(text)
  return (
    <div className="markdown">
      {blocks.map((block, i) => {
        if (block.type === 'heading') {
          const H = `h${block.level}` as keyof React.JSX.IntrinsicElements
          return <H key={i}>{renderInline(block.spans)}</H>
        }
        if (block.type === 'list') {
          const items = block.items.map((item, j) => <li key={j}>{renderInline(item)}</li>)
          return block.ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>
        }
        return <p key={i}>{renderInline(block.spans)}</p>
      })}
    </div>
  )
}

export default MarkdownView
