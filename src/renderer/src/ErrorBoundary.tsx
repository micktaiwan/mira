import { Component, type ErrorInfo, type ReactNode } from 'react'

// Why this exists: Mira's chrome (this React tree) and the page (a native
// WebContentsView) are two separate layers. When an uncaught render error hits
// React, it UNMOUNTS THE WHOLE TREE — the toolbar, tabs and URL bar vanish and
// only the native page layer stays painted, so the window looks like "just the
// web page, no chrome". Mira is vibe-coded across many parallel sessions, so a
// half-broken component landing live is a real, recurring cause of this.
//
// A root error boundary turns that silent blank-out into a visible fallback: the
// error message + stack + a Reload button, drawn where the chrome was. You see
// WHAT broke instead of a mysterious chromeless window, and can reload without
// killing the app.
//
// Only a class component can catch render errors (getDerivedStateFromError /
// componentDidCatch have no hook equivalent). The decision is kept as the static
// method so it stays unit-testable without a DOM (see ErrorBoundary.test.tsx).

export interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

/** Map a thrown value to the next boundary state. Static + pure so it is testable
 * without mounting React. Non-Error throws are wrapped so `error.message` is safe. */
export function deriveErrorState(error: unknown): ErrorBoundaryState {
  return { hasError: true, error: error instanceof Error ? error : new Error(String(error)) }
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return deriveErrorState(error)
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep a console trace too — the fallback shows the message, the console keeps
    // the component stack for debugging which session's component broke.
    console.error('Chrome render error caught by ErrorBoundary:', error, info.componentStack)
  }

  render(): ReactNode {
    const { hasError, error } = this.state
    if (!hasError) return this.props.children
    return (
      <div className="error-boundary" role="alert">
        <h1>Mira chrome crashed</h1>
        <p>A render error blanked the interface. The page itself is unaffected.</p>
        <pre className="error-boundary-message">{error?.message ?? 'Unknown error'}</pre>
        {error?.stack && <pre className="error-boundary-stack">{error.stack}</pre>}
        <button type="button" onClick={() => window.location.reload()}>
          Reload chrome
        </button>
      </div>
    )
  }
}
