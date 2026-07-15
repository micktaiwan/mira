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

/** The user-driven chat options (the bar beside Send). `provider` decides which
 * controls are relevant (the MCP toggle only bites for the claude-cli provider). */
export interface ChatOptions {
  provider: string
  model: string
  loadMcp: boolean
}

// The models the dropdown offers. Mirrors MODEL_CHOICES in src/main/llm.ts; kept
// renderer-local (a 4-item list) to avoid importing main into the renderer bundle.
// '' = Default: leave the model unset so the subscription / API picks its own.
const MODELS: ReadonlyArray<{ label: string; model: string }> = [
  { label: 'Default', model: '' },
  { label: 'Haiku', model: 'claude-haiku-4-5-20251001' },
  { label: 'Sonnet', model: 'claude-sonnet-5' },
  { label: 'Opus', model: 'claude-opus-4-8' }
]

interface Props {
  state: SkillPaneState
  onClose: () => void
  /** Run a free prompt (typed below) as the next chat turn. `withScreenshot`
   * attaches a picture of the current page (the 📷 button). */
  onPrompt: (prompt: string, withScreenshot?: boolean) => void
  /** Empty the conversation (Clear chat). */
  onClear: () => void
  /** Copy the latest assistant answer to the clipboard (Copy). */
  onCopy: () => void
  /** Current chat options (model / MCP), driven from the bar beside Send. */
  options: ChatOptions
  /** Persist an option change; main merges it into the llm config. */
  onOptions: (patch: { model?: string; loadMcp?: boolean }) => void
}

function SkillPane({
  state,
  onClose,
  onPrompt,
  onClear,
  onCopy,
  options,
  onOptions
}: Props): React.JSX.Element {
  const [prompt, setPrompt] = useState('')
  const [copied, setCopied] = useState(false)
  const threadRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // The pane only mounts when it opens (App renders it under `open &&`), so
  // focusing on mount = focus on every open (Cmd+J, toolbar ◪, run-skill).
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = (withScreenshot = false): void => {
    const p = prompt.trim()
    if (p === '') return
    onPrompt(p, withScreenshot)
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
  const hasAnswer = state.messages.some((m) => m.role === 'assistant' && m.text.trim() !== '')

  // Copy the latest answer, with a brief "Copied" confirmation on the button.
  const copy = (): void => {
    onCopy()
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <aside className="skill-pane">
      <header className="skill-pane-head">
        <span className="skill-pane-title">{state.title || 'AI'}</span>
        <button
          type="button"
          className="skill-pane-copy"
          aria-label="Copy answer"
          title="Copy the latest answer"
          disabled={!hasAnswer}
          onClick={copy}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
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
          ref={inputRef}
          className="skill-pane-input"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask about this page…  (Enter to send)"
          rows={2}
          spellCheck={false}
        />
        <div className="skill-pane-controls">
          {/* The user drives everything: which model answers, and (claude-cli only)
              whether their MCP servers load. Off = cheaper/faster (no MCP boot). */}
          <div className="skill-pane-opts">
            <label className="skill-pane-opt" title="Model that answers">
              <span className="skill-pane-opt-label">Model</span>
              <select
                className="skill-pane-model"
                value={options.model}
                onChange={(e) => onOptions({ model: e.target.value })}
              >
                {/* Surface an unknown persisted model (e.g. set in Settings) too. */}
                {!MODELS.some((m) => m.model === options.model) && options.model !== '' && (
                  <option value={options.model}>{options.model}</option>
                )}
                {MODELS.map((m) => (
                  <option key={m.model} value={m.model}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            {options.provider === 'claude-cli' && (
              <label
                className="skill-pane-opt skill-pane-mcp"
                title="Agent mode: let the chat use tools (Bash, files) and your MCP servers to ACT — not just answer. Off = a page chat that can still search the web (WebSearch + WebFetch)."
              >
                <input
                  type="checkbox"
                  checked={options.loadMcp}
                  onChange={(e) => onOptions({ loadMcp: e.target.checked })}
                />
                <span className="skill-pane-opt-label">Agent</span>
              </label>
            )}
          </div>
          <div className="skill-pane-actions">
            {/* Send WITH a screenshot of the page — for what the text can't capture
                (a map, a canvas). Only on explicit click; plain Send stays text-only. */}
            <button
              type="button"
              className="skill-pane-shot"
              title="Send with a screenshot of this page"
              aria-label="Send with screenshot"
              disabled={prompt.trim() === ''}
              onClick={() => submit(true)}
            >
              📷
            </button>
            <button type="submit" className="skill-pane-send" disabled={prompt.trim() === ''}>
              Send
            </button>
          </div>
        </div>
      </form>
    </aside>
  )
}

export default SkillPane
