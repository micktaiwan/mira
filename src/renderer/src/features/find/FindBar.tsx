import { useEffect, useRef, useState } from 'react'

// The find-in-page bar (Cmd+F). It lives INSIDE the toolbar row, next to the
// address bar — never over the page: a DOM overlay in the body region would be
// hidden behind the tab's WebContentsView (CLAUDE.md, "les deux pièges"). The
// bar is pure chrome: every action is a registry command (find-in-page /
// find-next / find-previous / find-stop), and the "n/m" tally arrives from
// main's found-in-page forwarding (onFindResult).

interface FindBarProps {
  /** Bumped by App on every find-open push, so Cmd+F re-focuses the input when
   * the bar is already open (a mount-only autofocus would miss it). */
  focusSeq: number
  /** Close the bar (Esc / ✕). App hides it and sends find-stop. */
  onClose: () => void
}

function FindBar({ focusSeq, onClose }: FindBarProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<{ matches: number; activeMatchOrdinal: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusSeq])

  useEffect(() => {
    return window.mira.onFindResult(setResult)
  }, [])

  const onChange = (text: string): void => {
    setQuery(text)
    if (text === '') {
      // Emptied input: clear the highlights and the tally, keep the bar open.
      setResult(null)
      void window.mira.command('find-stop', { action: 'clearSelection' })
      return
    }
    // Each edit starts a NEW search (findNext defaults to false server-side).
    void window.mira.command('find-in-page', { text })
  }

  const step = (forward: boolean): void => {
    if (query === '') return
    void window.mira.command(forward ? 'find-next' : 'find-previous')
  }

  return (
    <div className="find-bar">
      <input
        ref={inputRef}
        className="find-input"
        type="text"
        placeholder="Find in page"
        value={query}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            step(!e.shiftKey)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
      />
      <span className="find-count" aria-live="polite">
        {query !== '' && result ? `${result.activeMatchOrdinal}/${result.matches}` : ''}
      </span>
      <button
        type="button"
        className="nav-button find-step"
        title="Previous match (⇧⏎)"
        aria-label="Previous match"
        onClick={() => step(false)}
      >
        ‹
      </button>
      <button
        type="button"
        className="nav-button find-step"
        title="Next match (⏎)"
        aria-label="Next match"
        onClick={() => step(true)}
      >
        ›
      </button>
      <button
        type="button"
        className="nav-button find-step"
        title="Close (Esc)"
        aria-label="Close find bar"
        onClick={onClose}
      >
        ✕
      </button>
    </div>
  )
}

export default FindBar
