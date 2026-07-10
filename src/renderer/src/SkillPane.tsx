import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { SkillPaneState } from '../../preload/index.d'
import MarkdownView from './MarkdownView'

// The right-side AI panel. It does NOT float over the page: main shrinks the
// active WebContentsView by the pane's width (see profiles.ts layout), so it sits
// beside the page — no piège #3. The chrome holds no pane state; main pushes it
// and we render it. Every action is a command back to the registry.
//
// The pane is a chat: `state.messages` is the conversation (user questions +
// assistant answers). The prompt box appends a turn (run-prompt); a skill (Cmd+K)
// appends one too. "Clear" empties the thread; the pane can be opened anytime.

interface Props {
  state: SkillPaneState
  onClose: () => void
  /** Run a free prompt (typed below) as the next chat turn. */
  onPrompt: (prompt: string) => void
  /** Empty the conversation (Clear chat). */
  onClear: () => void
}

function SkillPane({ state, onClose, onPrompt, onClear }: Props): React.JSX.Element {
  const [prompt, setPrompt] = useState('')
  const threadRef = useRef<HTMLDivElement>(null)

  const submit = (): void => {
    const p = prompt.trim()
    if (p === '') return
    onPrompt(p)
    setPrompt('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends; Shift+Enter is a newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  // Keep the newest turn in view as the thread grows or the AI answers.
  const turnCount = state.messages.length
  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turnCount, state.status])

  const empty = turnCount === 0

  return (
    <aside className="skill-pane">
      <header className="skill-pane-head">
        <span className="skill-pane-title">{state.title || 'AI'}</span>
        <button
          type="button"
          className="skill-pane-clear"
          aria-label="Clear chat"
          title="Clear chat"
          disabled={empty && state.status !== 'error'}
          onClick={onClear}
        >
          Clear
        </button>
        <button
          type="button"
          className="skill-pane-close"
          aria-label="Close panel"
          onClick={onClose}
        >
          ✕
        </button>
      </header>
      <div className="skill-pane-thread" ref={threadRef}>
        {empty && state.status === 'idle' ? (
          <div className="skill-pane-hint">Ask a question about this page below.</div>
        ) : (
          state.messages.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} className="chat-turn chat-user">
                {m.text}
              </div>
            ) : (
              <div key={i} className="chat-turn chat-assistant">
                <MarkdownView text={m.text} />
              </div>
            )
          )
        )}
        {state.status === 'loading' && <div className="skill-pane-status">⏳ Working…</div>}
        {state.status === 'error' && <div className="skill-pane-error">{state.error}</div>}
      </div>
      <form
        className="skill-pane-prompt"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <textarea
          className="skill-pane-input"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask about this page…  (Enter to send)"
          rows={2}
          spellCheck={false}
        />
        <button type="submit" className="skill-pane-send" disabled={prompt.trim() === ''}>
          Send
        </button>
      </form>
    </aside>
  )
}

export default SkillPane
