import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import Sidebar, { type TabInfo } from './Sidebar'
import StatusBar from './StatusBar'
import Settings from './Settings'
import CommandPalette from './CommandPalette'
import SkillPane, { type ChatOptions } from './SkillPane'
import ResizeHandle from './ResizeHandle'
import ExtensionActions from './features/extensions/ExtensionActions'
import FindBar from './features/find/FindBar'
import { applyProfileColor, initialProfileColor } from './features/profile-theme/profile-theme'
import type { SkillPaneState } from '../../preload/index.d'

// Panel width bounds — must match SIDEBAR_WIDTH / SKILL_PANE_WIDTH in
// src/main/settings-store.ts (main clamps to the same range authoritatively).
const SIDEBAR_MIN = 160
const SIDEBAR_MAX = 480
const PANE_MIN = 260
const PANE_MAX = 720

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
  // The command palette. Main owns the state (it hides the web view so the overlay
  // is visible over what would otherwise be the page) and pushes changes; the
  // chrome renders the overlay to match. `mode` is 'launcher' (Cmd+K) or 'address'
  // (opened by typing in the URL bar), and `query` seeds its input.
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteMode, setPaletteMode] = useState<'launcher' | 'address'>('launcher')
  const [paletteQuery, setPaletteQuery] = useState('')
  // The right-side skill pane (a skill's AI result). Main owns it (it shrinks the
  // web view to make room) and pushes state; the chrome renders SkillPane to match.
  const [skillPane, setSkillPane] = useState<SkillPaneState>({
    open: false,
    title: '',
    status: 'idle',
    messages: []
  })
  // The chat's options (model / MCP), driven from the bar beside Send. Seeded from
  // the persisted llm config on mount; a change persists via set-chat-options.
  const [chatOptions, setChatOptionsState] = useState<ChatOptions>({
    provider: 'claude-cli',
    model: '',
    loadMcp: false
  })
  // The find-in-page bar (Cmd+F). It lives in the toolbar row (never over the
  // page — the WebContentsView would hide it). `findFocusSeq` bumps on every
  // find-open push so Cmd+F re-focuses the input even when already open.
  const [findOpen, setFindOpen] = useState(false)
  const [findFocusSeq, setFindFocusSeq] = useState(0)
  // Resizable panel widths (px). Seeded from settings on mount; a drag updates
  // them live (CSS var + a throttled command so main reflows the web view).
  const [sidebarWidth, setSidebarWidth] = useState(240)
  const [skillPaneWidth, setSkillPaneWidth] = useState(360)

  // Tint the chrome with this window's profile color: seeded from the chrome
  // URL (?color=…), re-tinted live when it changes in Settings.
  useEffect(() => {
    applyProfileColor(initialProfileColor())
    return window.mira.onProfileThemeChanged(applyProfileColor)
  }, [])

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
    // Main toggles the palette (Cmd+K flips it, a pick/Esc closes it) and pushes
    // the new visibility here, plus the mode + seeded query when opening.
    return window.mira.onTogglePalette((state) => {
      setPaletteOpen(state.open)
      if (state.open) {
        setPaletteMode(state.mode)
        setPaletteQuery(state.query)
      }
    })
  }, [])

  // Dismiss the palette: optimistically hide it, then tell main to close so it
  // re-shows the web view (main owns the state, keeping the view in sync).
  const closePalette = useCallback((): void => {
    setPaletteOpen(false)
    void window.mira.command('toggle-palette', { open: false })
  }, [])

  useEffect(() => {
    // Main asks for the find bar (Cmd+F / find-open): show it, and bump the seq
    // so an already-open bar re-focuses its input.
    return window.mira.onFindOpen(() => {
      setFindOpen(true)
      setFindFocusSeq((n) => n + 1)
    })
  }, [])

  // Close the find bar: hide it and end the search (clears the page highlights).
  const closeFindBar = useCallback((): void => {
    setFindOpen(false)
    void window.mira.command('find-stop', { action: 'clearSelection' })
  }, [])

  useEffect(() => {
    // Load any pane already open (survives a chrome reload) and then track pushes.
    const load = async (): Promise<void> => {
      const res = await run('get-skill-pane')
      if (res.ok && res.pane) setSkillPane(res.pane as SkillPaneState)
    }
    void load()
    // Main pushes the pane state as a skill runs (loading → done/error) and when
    // it closes; main also shrinks the web view to match, so we just render it.
    return window.mira.onSkillPane((state) => setSkillPane(state as SkillPaneState))
  }, [])

  // Close the pane: optimistically hide it, then tell main (which restores the web
  // view to full width). Main owns the state, keeping the view in sync.
  const closeSkillPane = useCallback((): void => {
    setSkillPane((prev) => ({ ...prev, open: false }))
    void window.mira.command('close-skill-pane')
  }, [])

  // Toggle the pane from the toolbar — always available, even with no result yet
  // (it then shows just the prompt box). Optimistic, then tell main (it owns the
  // state + the web-view width).
  const toggleSkillPane = useCallback((): void => {
    setSkillPane((prev) => ({ ...prev, open: !prev.open }))
    void window.mira.command('toggle-skill-pane')
  }, [])

  // Run a free prompt typed in the pane as the next chat turn. Optimistically
  // append the user turn and show loading; main pushes the real thread back
  // (loading with the turn, then the answer, or an error). `withScreenshot` (📷)
  // asks main to attach a picture of the current page to this turn.
  const runPrompt = useCallback((prompt: string, withScreenshot = false): void => {
    setSkillPane((prev) => ({
      ...prev,
      open: true,
      status: 'loading',
      title: prev.title || prompt,
      messages: [...prev.messages, { role: 'user', text: prompt }]
    }))
    void window.mira.command('run-prompt', { prompt, withScreenshot })
  }, [])

  // Clear the conversation (Clear chat button). Optimistically empty it, then tell
  // main (which owns the retained thread).
  const clearChat = useCallback((): void => {
    setSkillPane((prev) => ({ ...prev, status: 'idle', messages: [], error: undefined }))
    void window.mira.command('clear-chat')
  }, [])

  // Copy the latest answer to the clipboard (Copy button). Main owns the thread
  // and does the clipboard write, so the chrome just fires the command.
  const copyChat = useCallback((): void => {
    void window.mira.command('copy-chat')
  }, [])

  // Change a chat option (model / MCP). Optimistically reflect it, then persist —
  // main merges it into the llm config, so the next run-prompt uses the choice.
  const setChatOptions = useCallback((patch: { model?: string; loadMcp?: boolean }): void => {
    setChatOptionsState((prev) => ({ ...prev, ...patch }))
    void window.mira.command('set-chat-options', patch)
  }, [])

  // Load the persisted panel widths once (main is the source of truth).
  useEffect(() => {
    void (async () => {
      const res = await run('get-settings')
      if (!res.ok) return
      if (typeof res.sidebarWidth === 'number') setSidebarWidth(res.sidebarWidth)
      if (typeof res.skillPaneWidth === 'number') setSkillPaneWidth(res.skillPaneWidth)
      // Seed the chat options bar from the persisted llm config.
      const llm = res.llm as { provider?: string; model?: string; loadMcp?: boolean } | undefined
      if (llm) {
        setChatOptionsState({
          provider: llm.provider ?? 'claude-cli',
          model: llm.model ?? '',
          loadMcp: llm.loadMcp === true
        })
      }
    })()
  }, [])

  // Reflect the widths into the CSS vars that size the chrome panels (main sizes
  // the native web view separately, from the same numbers).
  useEffect(() => {
    document.documentElement.style.setProperty('--sidebar-width', `${sidebarWidth}px`)
  }, [sidebarWidth])
  useEffect(() => {
    document.documentElement.style.setProperty('--skill-pane-width', `${skillPaneWidth}px`)
  }, [skillPaneWidth])

  // During a drag, coalesce the width commands to one per animation frame so main
  // reflows the web view smoothly without a flood of IPC (it persists debounced).
  const sidebarRaf = useRef<{ w: number; id: number | null }>({ w: 0, id: null })
  const paneRaf = useRef<{ w: number; id: number | null }>({ w: 0, id: null })
  const sendWidth = (ref: typeof sidebarRaf, command: string, width: number): void => {
    ref.current.w = width
    if (ref.current.id !== null) return
    ref.current.id = requestAnimationFrame(() => {
      ref.current.id = null
      void window.mira.command(command, { width: ref.current.w })
    })
  }

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
  // native layer would otherwise cover. The tab url carries the requested
  // sub-section (mira://settings/<section>, set by open-settings / the
  // chrome://extensions alias); undefined when none was asked.
  const settingsTab = tabs.find((t) => t.id === activeId && t.kind === 'settings')
  const settingsActive = settingsTab !== undefined
  const settingsSection = settingsTab?.url.split('/')[3]

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
        <button
          type="button"
          className="nav-button"
          title="Reload (⌘R)"
          aria-label="Reload"
          onClick={() => window.mira.command('reload')}
        >
          ⟳
        </button>
        <form className="address-form" onSubmit={onSubmitUrl}>
          <input
            ref={addressInputRef}
            className="address-input"
            type="text"
            placeholder="Search or enter address"
            value={url}
            onChange={(e) => {
              // The URL bar is a launcher: the first keystroke opens the unified
              // palette in "address" mode, seeded with what was typed, and the
              // palette input takes over. Focus alone doesn't open it (a new tab
              // focuses the bar, and we don't want that to pop the palette).
              if (paletteOpen) return
              const v = e.target.value
              if (v === '') {
                setUrl('')
                return
              }
              // Open OPTIMISTICALLY in the renderer so the palette mounts this
              // render and its input grabs focus at once — waiting for main's
              // round-trip here would drop the keystrokes typed in between (the
              // classic "first char opens the overlay, the rest are lost" bug).
              setPaletteMode('address')
              setPaletteQuery(v)
              setPaletteOpen(true)
              // Still tell main so it hides the active web view under the overlay.
              void window.mira.command('toggle-palette', {
                open: true,
                mode: 'address',
                query: v
              })
            }}
            onBlur={() => setUrl(activeUrlRef.current)}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
          />
        </form>
        {/* Find in page (Cmd+F). Mounted only while open so its query/tally state
            starts fresh each time; sits in the toolbar row, beside the address
            bar (an overlay over the page would be hidden by the native view). */}
        {findOpen && <FindBar focusSeq={findFocusSeq} onClose={closeFindBar} />}
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
        {/* Extension action buttons (Dark Reader & co) — a lib custom element
            bound to THIS window's profile session (features/extensions). */}
        <ExtensionActions />
        {/* Always-present toggle for the AI panel: open it anytime to type a prompt
            or see the last result; click again to close. */}
        <button
          type="button"
          className={`nav-button${skillPane.open ? ' active' : ''}`}
          title="AI panel"
          aria-label="Toggle AI panel"
          aria-pressed={skillPane.open}
          onClick={toggleSkillPane}
        >
          ◪
        </button>
        {/* Explicit window-drag zone to the right of the URL bar. The toolbar is
            already a drag region, but the address field (flex) eats all the free
            space, leaving nothing to grab — Kova's model, where empty tab-bar space
            initiates a window drag (window.rs performWindowDragWithEvent). Shows the
            app name + version; a small fixed handle, not a stretching zone. */}
        <div className="toolbar-drag" aria-hidden="true">
          Mira <span className="toolbar-drag-version">{__APP_VERSION__}</span>
        </div>
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
            <Settings section={settingsSection} />
          </div>
        )}
      </div>
      <StatusBar />
      {/* Mounted only while open, so its search/selection state starts fresh each
          time. Main has hidden the web view, so this overlay is visible. `mode`
          decides the default target of a page pick (current tab in address mode,
          new tab in launcher mode); `initialQuery` seeds the input. */}
      {paletteOpen && (
        <CommandPalette onClose={closePalette} mode={paletteMode} initialQuery={paletteQuery} />
      )}
      {/* The right-side skill pane. Main shrinks the web view by its width while
          open (profiles.ts layout), so it sits beside the page rather than over it. */}
      {skillPane.open && (
        <SkillPane
          state={skillPane}
          onClose={closeSkillPane}
          onPrompt={runPrompt}
          onClear={clearChat}
          onCopy={copyChat}
          options={chatOptions}
          onOptions={setChatOptions}
        />
      )}
      {/* Drag handles at each panel's inner edge. Live-resize the CSS var and, per
          frame, tell main to reflow the web view; the final width persists on release. */}
      {!panelCollapsed && (
        <ResizeHandle
          className="resize-handle-sidebar"
          width={sidebarWidth}
          min={SIDEBAR_MIN}
          max={SIDEBAR_MAX}
          invert={false}
          onResize={(w) => {
            setSidebarWidth(w)
            sendWidth(sidebarRaf, 'set-sidebar-width', w)
          }}
          onCommit={(w) => {
            setSidebarWidth(w)
            void window.mira.command('set-sidebar-width', { width: w })
          }}
        />
      )}
      {skillPane.open && (
        <ResizeHandle
          className="resize-handle-pane"
          width={skillPaneWidth}
          min={PANE_MIN}
          max={PANE_MAX}
          invert={true}
          onResize={(w) => {
            setSkillPaneWidth(w)
            sendWidth(paneRaf, 'set-skill-pane-width', w)
          }}
          onCommit={(w) => {
            setSkillPaneWidth(w)
            void window.mira.command('set-skill-pane-width', { width: w })
          }}
        />
      )}
    </div>
  )
}

export default App
