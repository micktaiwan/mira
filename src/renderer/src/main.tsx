import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

// One renderer bundle, one root. Every window is a profile window (loaded with
// ?profile=…). Settings is no longer a separate window: App renders <Settings/>
// inline when the active tab is the internal Settings tab (see App.tsx).
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
