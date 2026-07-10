import type { SkillPaneState } from '../../preload/index.d'
import MarkdownView from './MarkdownView'

// The right-side pane that shows a skill's result (an AI summary). It does NOT
// float over the page: main shrinks the active WebContentsView by the pane's
// width (see profiles.ts layout), so the pane sits beside the page — no piège #3.
// The chrome holds no pane state; main pushes it and we render it. Closing is a
// command back to the registry (close-skill-pane), like every other action.

interface Props {
  state: SkillPaneState
  onClose: () => void
}

function SkillPane({ state, onClose }: Props): React.JSX.Element {
  return (
    <aside className="skill-pane">
      <header className="skill-pane-head">
        <span className="skill-pane-title">{state.title}</span>
        <button
          type="button"
          className="skill-pane-close"
          aria-label="Close pane"
          onClick={onClose}
        >
          ✕
        </button>
      </header>
      <div className="skill-pane-body">
        {state.status === 'loading' ? (
          <div className="skill-pane-status">⏳ Working…</div>
        ) : state.status === 'error' ? (
          <div className="skill-pane-error">{state.error}</div>
        ) : (
          <div className="skill-pane-text">
            <MarkdownView text={state.text ?? ''} />
          </div>
        )}
      </div>
    </aside>
  )
}

export default SkillPane
