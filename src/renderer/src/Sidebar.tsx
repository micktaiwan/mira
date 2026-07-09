// One tab as the chrome renders it. Structurally identical to the registry's
// TabInfo and the pushed TabsState; kept local to the renderer (like App's and
// Settings' own view models) rather than imported across the preload boundary.
export interface TabInfo {
  id: string
  title: string
  url: string
  favicon: string | null
}

// The vertical tab panel on the left (Arc-style). Pure presentation: it holds no
// tab state and never mutates the browser — it renders the strip main pushed and
// turns clicks into commands via the callbacks App wires to the registry. See
// CLAUDE.md, "tout pilotable".

/** A one-letter badge standing in for the favicon: the first letter of the tab's
 * title, else of its host. Remote favicon images are blocked by the chrome's CSP
 * (img-src 'self' data:), so we don't render tab.favicon as an <img> yet — the
 * URL still travels in the tab metadata for socket/MCP consumers and a later CSP
 * relax. */
function tabInitial(tab: TabInfo): string {
  const fromTitle = tab.title.trim()[0]
  if (fromTitle) return fromTitle.toUpperCase()
  try {
    const host = new URL(tab.url).hostname.replace(/^www\./, '')
    return host[0]?.toUpperCase() ?? '•'
  } catch {
    return '•'
  }
}

function TabRow({
  tab,
  active,
  onSelect,
  onClose
}: {
  tab: TabInfo
  active: boolean
  onSelect: () => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <li className={active ? 'tab-row active' : 'tab-row'} onClick={onSelect} title={tab.url}>
      <span className="tab-favicon" aria-hidden="true">
        {tabInitial(tab)}
      </span>
      <span className="tab-title">{tab.title || tab.url || 'New tab'}</span>
      <button
        type="button"
        className="tab-close"
        aria-label="Close tab"
        title="Close tab"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
      >
        ×
      </button>
    </li>
  )
}

function Sidebar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNew
}: {
  tabs: TabInfo[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
}): React.JSX.Element {
  return (
    <nav className="sidebar">
      <button type="button" className="sidebar-new" onClick={onNew} title="New tab (⌘T)">
        <span className="sidebar-new-plus">+</span> New tab
      </button>
      <ul className="tab-list">
        {tabs.map((t) => (
          <TabRow
            key={t.id}
            tab={t}
            active={t.id === activeId}
            onSelect={() => onSelect(t.id)}
            onClose={() => onClose(t.id)}
          />
        ))}
      </ul>
    </nav>
  )
}

export default Sidebar
