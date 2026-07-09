import { useEffect, useRef, useState, type FormEvent } from 'react'
import Sidebar, { type TabInfo } from './Sidebar'
import StatusBar from './StatusBar'
import Settings from './Settings'

/** Thin wrapper around the command bus; every command returns { ok, ... }. */
async function run(name: string, params?: unknown): Promise<Record<string, unknown>> {
  return (await window.mira.command(name, params)) as Record<string, unknown>
}

/** The active tab's URL, or '' when there is no active tab. */
function activeUrlOf(tabs: TabInfo[], activeId: string | null): string {
  return tabs.find((t) => t.id === activeId)?.url ?? ''
}

/** A favorites tree node as the chrome sees it. The full tree lives in the native
 * Bookmarks menu (main-side); the chrome only needs the flat url→id map to drive
 * the address-bar star, so `url`/`children` are optional here. */
interface BookmarkNode {
  id: string
  kind: 'url' | 'folder'
  title: string
  url?: string
  children?: BookmarkNode[]
}

/** Every url favorite in the tree, flattened (folders dropped) — enough to tell
 * whether the active page is bookmarked and to find its id for removal. */
function flattenBookmarkUrls(tree: BookmarkNode[]): Array<{ id: string; url: string }> {
  const out: Array<{ id: string; url: string }> = []
  for (const node of tree) {
    if (node.kind === 'url' && node.url) out.push({ id: node.id, url: node.url })
    else if (node.children) out.push(...flattenBookmarkUrls(node.children))
  }
  return out
}

function App(): React.JSX.Element {
  // The address bar mirrors the active tab's URL; `url` is what it shows (the
  // page URL, or the user's edit while the field is focused).
  const [url, setUrl] = useState('')
  const addressInputRef = useRef<HTMLInputElement>(null)
  // Always-fresh copy of the active tab's URL, so the focus/blur handlers can
  // read it without depending on React's async state.
  const activeUrlRef = useRef('')
  // The chrome holds no tab state of its own: main pushes the strip, we render
  // it, and every action is a command back to the registry (CLAUDE.md).
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  // Favorites are global (app-wide) and rendered in the native Bookmarks menu.
  // The chrome keeps the tree only to drive the address-bar star; main pushes it.
  const [bookmarks, setBookmarks] = useState<BookmarkNode[]>([])

  // Mirror the active tab's URL into the bar, unless the user is editing it.
  const syncAddressBar = (nextTabs: TabInfo[], nextActiveId: string | null): void => {
    const active = activeUrlOf(nextTabs, nextActiveId)
    activeUrlRef.current = active
    if (document.activeElement !== addressInputRef.current) setUrl(active)
  }

  useEffect(() => {
    const load = async (): Promise<void> => {
      const res = await run('list-tabs')
      if (!res.ok) return
      const nextTabs = (res.tabs as TabInfo[]) ?? []
      const nextActiveId = (res.activeId as string | null) ?? null
      setTabs(nextTabs)
      setActiveId(nextActiveId)
      setPanelCollapsed(Boolean(res.panelCollapsed))
      syncAddressBar(nextTabs, nextActiveId)
    }
    void load()
    // Main pushes on every tab change (new / close / select / navigate / panel
    // toggle), so the sidebar and address bar stay live without polling.
    return window.mira.onTabsChanged((state) => {
      setTabs(state.tabs)
      setActiveId(state.activeId)
      setPanelCollapsed(state.panelCollapsed)
      syncAddressBar(state.tabs, state.activeId)
    })
  }, [])

  useEffect(() => {
    const load = async (): Promise<void> => {
      const res = await run('list-bookmarks')
      if (res.ok) setBookmarks((res.tree as BookmarkNode[]) ?? [])
    }
    void load()
    // Main pushes on every add / remove / move (from this window, the Cmd+D menu,
    // or another window — favorites are global), so the star stays live.
    return window.mira.onBookmarksChanged((state) => setBookmarks(state.tree))
  }, [])

  useEffect(() => {
    // Main pushes this when a new tab opens (click or Cmd+T): show the new tab's
    // URL and select it all, so the user can type a destination right over it.
    return window.mira.onFocusAddressBar(() => {
      const active = activeUrlRef.current
      setUrl(active)
      const el = addressInputRef.current
      if (!el) return
      // Apply the value now so select() covers the whole url before React
      // re-renders, then select-all.
      el.value = active
      el.focus()
      el.select()
    })
  }, [])

  const onSubmitUrl = (e: FormEvent): void => {
    e.preventDefault()
    // The chrome never navigates directly: it asks the command registry to.
    window.mira.command('navigate', { url })
  }

  // When the Settings tab is active, main hides every web view (the settings tab
  // has none), so the chrome renders <Settings/> in the body region that the
  // native layer would otherwise cover.
  const settingsActive = tabs.find((t) => t.id === activeId)?.kind === 'settings'

  // The star reflects whether the ACTIVE tab's real url (not the edited bar text)
  // is already a favorite. Empty when there is no active tab → the star disables.
  // Favorites are a tree (folders), so flatten to url nodes to find a match.
  const activeUrl = activeUrlOf(tabs, activeId)
  const currentBookmark = activeUrl
    ? flattenBookmarkUrls(bookmarks).find((b) => b.url === activeUrl)
    : undefined

  const onToggleBookmark = (): void => {
    // Toggle the active page: un-star removes it, star adds it. add-bookmark with
    // no url defaults to the active tab (same as the Cmd+D menu).
    if (currentBookmark) window.mira.command('remove-bookmark', { id: currentBookmark.id })
    else window.mira.command('add-bookmark', {})
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
            ref={addressInputRef}
            className="address-input"
            type="text"
            placeholder="Search or enter address"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={() => setUrl(activeUrlRef.current)}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
          />
        </form>
        <button
          type="button"
          className={`nav-button star-button${currentBookmark ? ' active' : ''}`}
          title={currentBookmark ? 'Remove from favorites' : 'Add to favorites (⌘D)'}
          aria-label="Toggle favorite"
          aria-pressed={currentBookmark ? true : false}
          disabled={!activeUrl || settingsActive}
          onClick={onToggleBookmark}
        >
          {currentBookmark ? '★' : '☆'}
        </button>
      </div>
      <div className="body">
        {!panelCollapsed && (
          <Sidebar
            tabs={tabs}
            activeId={activeId}
            onSelect={(id) => window.mira.command('select-tab', { id })}
            onClose={(id) => window.mira.command('close-tab', { id })}
            onNew={() => window.mira.command('new-tab')}
            onMove={(id, toIndex) => window.mira.command('move-tab', { id, toIndex })}
            onPin={(id) => window.mira.command('pin-tab', { id })}
            onUnpin={(id) => window.mira.command('unpin-tab', { id })}
          />
        )}
        {/* A web tab's WebContentsView (a native layer) covers the rest of the
            body. The Settings tab has no view, so main hides all views and we
            render the Settings panel here instead. */}
        {settingsActive && (
          <div className="settings-host">
            <Settings />
          </div>
        )}
      </div>
      <StatusBar />
    </div>
  )
}

export default App
