import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './ErrorBoundary'

// One renderer bundle, one root. Every window is a profile window (loaded with
// ?profile=…). Settings is no longer a separate window: App renders <Settings/>
// inline when the active tab is the internal Settings tab (see App.tsx).
//
// ErrorBoundary wraps App so an uncaught render error shows a fallback instead of
// unmounting the whole chrome (which leaves only the native page painted — the
// "no tabs, no URL bar, just the web page" symptom). See ErrorBoundary.tsx.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
