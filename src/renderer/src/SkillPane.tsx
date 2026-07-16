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
 * controls are relevant (the Agent toggle only bites for the claude-cli provider). */
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
  /** Current chat options (model / agent), driven from the bar beside Send. */
  options: ChatOptions
  /** Persist an option change; main merges it into the llm config. */
  onOptions: (patch: { model?: string; loadMcp?: boolean }) => void
}

// ── Inline icons ────────────────────────────────────────────────────────────
// Small stroked glyphs (currentColor, so they inherit hover/disabled state).
// Kept inline rather than pulling an icon dependency into the chrome bundle.

function StarIcon({ size = 15 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      className="skill-pane-star"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 2.5l2.35 6.02L20.5 9l-4.75 3.9L17.3 19 12 15.4 6.7 19l1.55-6.1L3.5 9l6.15-.48L12 2.5z" />
    </svg>
  )
}

function CopyIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </svg>
  )
}

function CheckIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 12.5l5 5 11-11" />
    </svg>
  )
}

function TrashIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7" />
    </svg>
  )
}

function CloseIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
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
  const canSend = prompt.trim() !== ''

  // Copy the latest answer, with a brief check confirmation on the button.
  const copy = (): void => {
    onCopy()
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <aside className="skill-pane">
      <header className="skill-pane-head">
        <span className="skill-pane-title">
          <StarIcon />
          <span className="skill-pane-title-text">{state.title || 'AI'}</span>
        </span>
        <div className="skill-pane-tools">
          <button
            type="button"
            className={`skill-pane-tool${copied ? ' is-done' : ''}`}
            aria-label="Copy answer"
            title="Copy the latest answer"
            disabled={!hasAnswer}
            onClick={copy}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
          <button
            type="button"
            className="skill-pane-tool"
            aria-label="Clear chat"
            title="Clear chat"
            disabled={empty && state.status !== 'error'}
            onClick={onClear}
          >
            <TrashIcon />
          </button>
          <button
            type="button"
            className="skill-pane-tool skill-pane-tool-close"
            aria-label="Close panel"
            title="Close"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>
      </header>

      <div className="skill-pane-thread" ref={threadRef}>
        {empty && state.status === 'idle' ? (
          <div className="skill-pane-hint">
            <StarIcon size={26} />
            <span className="skill-pane-hint-text">Ask a question about this page below.</span>
          </div>
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
        {state.status === 'loading' && (
          <div className="skill-pane-status">
            <span className="skill-pane-status-dots">
              <span />
              <span />
              <span />
            </span>
            Working…
          </div>
        )}
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
            <select
              className="skill-pane-model"
              title="Model that answers"
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
            {options.provider === 'claude-cli' && (
              <label
                className={`skill-pane-toggle${options.loadMcp ? ' is-on' : ''}`}
                title="Agent mode: let the chat use tools (Bash, files) and your MCP servers to ACT — not just answer. Off = a page chat that can still search the web (WebSearch + WebFetch)."
              >
                <input
                  type="checkbox"
                  checked={options.loadMcp}
                  onChange={(e) => onOptions({ loadMcp: e.target.checked })}
                />
                <span className="skill-pane-toggle-track">
                  <span className="skill-pane-toggle-thumb" />
                </span>
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
              disabled={!canSend}
              onClick={() => submit(true)}
            >
              📷
            </button>
            <button type="submit" className="skill-pane-send" disabled={!canSend}>
              Send
            </button>
          </div>
        </div>
      </form>
    </aside>
  )
}

export default SkillPane
