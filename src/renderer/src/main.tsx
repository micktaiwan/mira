import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import Settings from './Settings'

// One renderer bundle, two views. Profile windows load with ?profile=…; the
// Settings window loads with ?view=settings (see src/main/index.ts).
const view = new URLSearchParams(window.location.search).get('view')
const Root = view === 'settings' ? Settings : App

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>
)
