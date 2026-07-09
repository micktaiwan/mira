import { useEffect, useState, type FormEvent } from 'react'
import Sidebar, { type TabInfo } from './Sidebar'

/** Thin wrapper around the command bus; every command returns { ok, ... }. */
async function run(name: string, params?: unknown): Promise<Record<string, unknown>> {
  return (await window.mira.command(name, params)) as Record<string, unknown>
}

function App(): React.JSX.Element {
  const [url, setUrl] = useState('')
  // The chrome holds no tab state of its own: main pushes the strip, we render
  // it, and every action is a command back to the registry (CLAUDE.md).
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [panelCollapsed, setPanelCollapsed] = useState(false)

  useEffect(() => {
    const load = async (): Promise<void> => {
      const res = await run('list-tabs')
      if (!res.ok) return
      setTabs((res.tabs as TabInfo[]) ?? [])
      setActiveId((res.activeId as string | null) ?? null)
      setPanelCollapsed(Boolean(res.panelCollapsed))
    }
    void load()
    // Main pushes on every tab change (new / close / select / navigate / panel
    // toggle), so the sidebar stays live without polling.
    return window.mira.onTabsChanged((state) => {
      setTabs(state.tabs)
      setActiveId(state.activeId)
      setPanelCollapsed(state.panelCollapsed)
    })
  }, [])

  const onSubmitUrl = (e: FormEvent): void => {
    e.preventDefault()
    // The chrome never navigates directly: it asks the command registry to.
    window.mira.command('navigate', { url })
  }

  return (
    <div className="chrome">
      <div className="toolbar">
        <button
          type="button"
          className="nav-button"
          title={panelCollapsed ? 'Show tabs' : 'Hide tabs'}
          aria-label="Toggle tab panel"
          onClick={() => window.mira.command('toggle-tabs-panel')}
        >
          {panelCollapsed ? '◧' : '◨'}
        </button>
        <button
          type="button"
          className="nav-button"
          title="Back (⌘←)"
          aria-label="Back"
          onClick={() => window.mira.command('back')}
        >
          ‹
        </button>
        <button
          type="button"
          className="nav-button"
          title="Forward (⌘→)"
          aria-label="Forward"
          onClick={() => window.mira.command('forward')}
        >
          ›
        </button>
        <form className="address-form" onSubmit={onSubmitUrl}>
          <input
            className="address-input"
            type="text"
            placeholder="Search or enter address"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
          />
        </form>
      </div>
      <div className="body">
        {!panelCollapsed && (
          <Sidebar
            tabs={tabs}
            activeId={activeId}
            onSelect={(id) => window.mira.command('select-tab', { id })}
            onClose={(id) => window.mira.command('close-tab', { id })}
            onNew={() => window.mira.command('new-tab')}
          />
        )}
        {/* The active tab's WebContentsView (a native layer) covers the rest of
            the body; nothing to render on the right. */}
      </div>
    </div>
  )
}

export default App
