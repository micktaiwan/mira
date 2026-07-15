import { useEffect, useRef, useState, type DragEvent } from 'react'
import FolderHeader, { type TabFolder } from './features/tab-folders/FolderHeader'

// One tab as the chrome renders it. Structurally identical to the registry's
// TabInfo and the pushed TabsState; kept local to the renderer (like App's and
// Settings' own view models) rather than imported across the preload boundary.
export interface TabInfo {
  id: string
  title: string
  url: string
  favicon: string | null
  /** Lazy-load state: false for an asleep tab (dimmed until first selected). */
  loaded: boolean
  /** 'settings' for the internal Settings tab (gear badge), else 'web'. */
  kind: 'web' | 'settings'
  /** Pinned: rendered as a compact square in the grid at the head of the strip. */
  pinned: boolean
  /** Id of the tab folder this tab is in, or null when loose (in no folder). The
   * sidebar groups tabs by this into the folders section vs the loose list. */
  folderId: string | null
}

// The vertical tab panel on the left (Arc-style). Pure presentation: it holds no
// tab state and never mutates the browser — it renders the strip main pushed and
// turns clicks / drags into commands via the callbacks App wires to the registry.
// See CLAUDE.md, "tout pilotable". Reordering is a `move-tab` command; the drag
// gesture here only computes the target index and calls onMove.

/** A one-letter badge standing in for the favicon (first letter of the tab's
 * title, else of its host): the fallback while a page has not provided an icon
 * yet, or when its icon URL fails to load. */
function initialFor(title: string, url: string): string {
  const fromTitle = title.trim()[0]
  if (fromTitle) return fromTitle.toUpperCase()
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    return host[0]?.toUpperCase() ?? '•'
  } catch {
    return '•'
  }
}

function tabInitial(tab: TabInfo): string {
  return initialFor(tab.title, tab.url)
}

/** A tab's favicon: the real image when the page provided one (the chrome's CSP
 * allows remote http(s) images), else the one-letter badge. A failing icon URL
 * is remembered per-src so the badge shows instead of a broken image — and a
 * later favicon change still retries. */
function Favicon({ tab }: { tab: TabInfo }): React.JSX.Element {
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null)
  if (tab.kind === 'settings') {
    return (
      <span className="tab-favicon" aria-hidden="true">
        ⚙
      </span>
    )
  }
  if (!tab.favicon || tab.favicon === brokenSrc) {
    return (
      <span className="tab-favicon" aria-hidden="true">
        {tabInitial(tab)}
      </span>
    )
  }
  return (
    <img
      className="tab-favicon tab-favicon-img"
      src={tab.favicon}
      alt=""
      draggable={false}
      onError={() => setBrokenSrc(tab.favicon)}
    />
  )
}

type DropPos = 'before' | 'after'

// One pinned tab: a compact square (favicon only) in the wrapping grid at the
// head of the strip. Click selects it. Deliberately no close button — Cmd+W
// pressed twice in a row closes a pinned tab. Drag reorders within the pinned
// block (the grid flows horizontally, so the drop line is left/right, not
// top/bottom). Right-click opens the same native tab menu as a regular tab (with
// Unpin Tab inside), like every browser — it no longer unpins directly.
function PinnedSquare({
  tab,
  active,
  dragging,
  dropPos,
  onSelect,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd
}: {
  tab: TabInfo
  active: boolean
  dragging: boolean
  dropPos: DropPos | null
  onSelect: () => void
  /** Right-click: ask main to pop the native tab menu for this tab. */
  onContextMenu: () => void
  onDragStart: () => void
  onDragOver: (pos: DropPos) => void
  onDrop: () => void
  onDragEnd: (e: DragEvent<HTMLLIElement>) => void
}): React.JSX.Element {
  const isSettings = tab.kind === 'settings'
  const className = [
    'pinned-tab',
    active && 'active',
    !isSettings && !tab.loaded && 'asleep',
    dragging && 'dragging',
    dropPos === 'before' && 'drop-before',
    dropPos === 'after' && 'drop-after'
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <li
      className={className}
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu()
      }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', tab.id)
        onDragStart()
      }}
      onDragOver={(e: DragEvent<HTMLLIElement>) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const rect = e.currentTarget.getBoundingClientRect()
        onDragOver(e.clientX < rect.left + rect.width / 2 ? 'before' : 'after')
      }}
      onDrop={(e) => {
        e.preventDefault()
        onDrop()
      }}
      onDragEnd={onDragEnd}
    >
      <Favicon tab={tab} />
    </li>
  )
}

function TabRow({
  tab,
  active,
  dragging,
  dropPos,
  onSelect,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd
}: {
  tab: TabInfo
  active: boolean
  dragging: boolean
  dropPos: DropPos | null
  onSelect: () => void
  /** Right-click: ask main to pop the native tab menu for this tab. */
  onContextMenu: () => void
  onDragStart: () => void
  onDragOver: (pos: DropPos) => void
  onDrop: () => void
  onDragEnd: (e: DragEvent<HTMLLIElement>) => void
}): React.JSX.Element {
  const isSettings = tab.kind === 'settings'
  const className = [
    'tab-row',
    active && 'active',
    // The Settings tab is chrome, not a lazy-loaded page — never dim it as asleep.
    !isSettings && !tab.loaded && 'asleep',
    isSettings && 'tab-settings',
    dragging && 'dragging',
    dropPos === 'before' && 'drop-before',
    dropPos === 'after' && 'drop-after'
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <li
      className={className}
      // The tab id, so a cross-window re-attach (detach-tab) can hit-test the drop
      // point against these rows from main (executeJavaScript in the target window)
      // — HTML5 drag doesn't cross OS windows, so the target renderer never sees a
      // dragover of its own.
      data-tab-id={tab.id}
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu()
      }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', tab.id)
        onDragStart()
      }}
      onDragOver={(e: DragEvent<HTMLLIElement>) => {
        e.preventDefault()
        // Stop the folder wrapper's own dragOver from clobbering this row's
        // before/after indicator when the row is inside a folder.
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        const rect = e.currentTarget.getBoundingClientRect()
        onDragOver(e.clientY < rect.top + rect.height / 2 ? 'before' : 'after')
      }}
      onDrop={(e) => {
        e.preventDefault()
        // Let the row's own drop (reorder / cross-section join) win over the
        // folder wrapper's "drop into folder".
        e.stopPropagation()
        onDrop()
      }}
      onDragEnd={onDragEnd}
    >
      <Favicon tab={tab} />
      <span className="tab-title">
        {isSettings ? 'Settings' : tab.title || tab.url || 'New tab'}
      </span>
    </li>
  )
}

function Sidebar({
  tabs,
  activeId,
  onSelect,
  onNew,
  onMove,
  onContextMenu,
  folders,
  onToggleFolder,
  onRenameFolder,
  onRemoveFolder,
  onFolderContextMenu,
  onMoveTabToFolder,
  onDetach
}: {
  tabs: TabInfo[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onMove: (id: string, toIndex: number) => void
  /** Right-click on a tab: main pops the native tab menu for that tab id. */
  onContextMenu: (id: string) => void
  /** The window's tab folders (metadata, in order), rendered between the pinned
   * grid and the loose tab list. */
  folders: TabFolder[]
  onToggleFolder: (id: string) => void
  onRenameFolder: (id: string, title: string) => void
  onRemoveFolder: (id: string) => void
  /** Right-click on a folder header: main pops the native folder menu (color, …). */
  onFolderContextMenu: (id: string) => void
  /** Move a tab into folder `folderId` (or out to loose with null) — the drag
   * gesture that crosses sections, and the drop-onto-a-folder-header gesture. */
  onMoveTabToFolder: (tabId: string, folderId: string | null) => void
  /** Tear a tab off into its own window: fired when a tab is dropped OUTSIDE this
   * window (another screen, the desktop, or onto another Mira window). `screenX/Y`
   * are the drop point in screen coordinates; main decides new-window vs re-attach. */
  onDetach: (tabId: string, screenX: number, screenY: number) => void
}): React.JSX.Element {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; pos: DropPos } | null>(null)
  // The folder header a dragged tab is hovering (drop = move that tab into it).
  const [dropFolderId, setDropFolderId] = useState<string | null>(null)
  // The folder whose name field is open. Sidebar-owned so a JUST-CREATED folder
  // opens straight into edit mode (a native "New Folder" menu item can't prompt).
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null)

  // Auto-open the name field for a freshly created folder, so the native "New
  // Folder" menu item lands in an editable, selected name field. We fire only when
  // exactly ONE new folder appears AND it still carries the create flow's default
  // name ("New folder") — so restored folders (real names, possibly arriving async
  // after mount) never pop an editor. The first run just seeds the known ids.
  const knownFolderIds = useRef<string[]>([])
  const seeded = useRef(false)
  useEffect(() => {
    const ids = folders.map((f) => f.id)
    if (!seeded.current) {
      seeded.current = true
      knownFolderIds.current = ids
      return
    }
    const added = ids.filter((id) => !knownFolderIds.current.includes(id))
    knownFolderIds.current = ids
    if (added.length === 1 && folders.find((f) => f.id === added[0])?.title === 'New folder') {
      setEditingFolderId(added[0])
    }
  }, [folders])

  // Pinned tabs form a contiguous block at the head of the strip (a tab-store
  // invariant). The rest split into folders (grouped by folderId, in the folders'
  // order) and loose tabs (no folder) — the fixed sections pinned → folders →
  // loose. Two drag gestures: reorder WITHIN a section (move-tab, full-array
  // index), and move ACROSS sections — dropping a tab on a row of another section,
  // or on a folder header, changes its folder (move-tab-to-folder).
  const pinnedTabs = tabs.filter((t) => t.pinned)
  const regularTabs = tabs.filter((t) => !t.pinned)
  const looseTabs = regularTabs.filter((t) => t.folderId === null)
  const folderTabsOf = (folderId: string): TabInfo[] =>
    regularTabs.filter((t) => t.folderId === folderId)

  const reset = (): void => {
    setDraggingId(null)
    setDropTarget(null)
    setDropFolderId(null)
  }

  // End of a tab drag. When the tab was dropped OUTSIDE this window's frame (another
  // screen, the desktop, or over another Mira window), tear it off — HTML5 drag can't
  // cross OS windows, so we detect it here from the drop's screen coordinates and hand
  // them to main, which opens a new window there or re-attaches onto the window under
  // the point. A drop back INSIDE the window was already handled by onDrop (reorder /
  // folder move), which cleared draggingId — so this only fires for true outside drops.
  const handleDragEnd = (e: DragEvent<HTMLLIElement>): void => {
    const id = draggingId
    const outside =
      e.screenX < window.screenX ||
      e.screenX > window.screenX + window.outerWidth ||
      e.screenY < window.screenY ||
      e.screenY > window.screenY + window.outerHeight
    if (id && outside) onDetach(id, e.screenX, e.screenY)
    reset()
  }

  const commitDrop = (): void => {
    if (draggingId && dropTarget) {
      const dragged = tabs.find((t) => t.id === draggingId)
      const over = tabs.find((t) => t.id === dropTarget.id)
      if (dragged && over) {
        // Dropped onto a row of another section → first change membership (join the
        // target's folder, or go loose). Then, in BOTH cases, reorder to the drop
        // position so the tab lands exactly where it was dropped (membership alone
        // leaves it at its old strip index, i.e. at the end of the target folder).
        if ((dragged.folderId ?? null) !== (over.folderId ?? null)) {
          onMoveTabToFolder(draggingId, over.folderId ?? null)
        }
        const from = tabs.findIndex((t) => t.id === draggingId)
        const overIndex = tabs.findIndex((t) => t.id === dropTarget.id)
        const insertBefore = dropTarget.pos === 'before' ? overIndex : overIndex + 1
        const toIndex = from < insertBefore ? insertBefore - 1 : insertBefore
        if (toIndex !== from) onMove(draggingId, toIndex)
      }
    }
    reset()
  }

  // Drop a dragged tab onto a folder header → move it into that folder.
  const dropIntoFolder = (folderId: string): void => {
    if (draggingId) onMoveTabToFolder(draggingId, folderId)
    reset()
  }

  // One tab row, wired to the shared drag state — reused for loose tabs and for
  // the tabs inside each folder, so both sections share one reorder gesture.
  const renderRow = (t: TabInfo): React.JSX.Element => (
    <TabRow
      key={t.id}
      tab={t}
      active={t.id === activeId}
      dragging={t.id === draggingId}
      dropPos={dropTarget?.id === t.id && t.id !== draggingId ? dropTarget.pos : null}
      onSelect={() => onSelect(t.id)}
      onContextMenu={() => onContextMenu(t.id)}
      onDragStart={() => setDraggingId(t.id)}
      onDragOver={(pos) => setDropTarget({ id: t.id, pos })}
      onDrop={commitDrop}
      onDragEnd={handleDragEnd}
    />
  )

  return (
    <nav className="sidebar">
      <button type="button" className="sidebar-new" onClick={onNew} title="New tab (⌘T)">
        <span className="sidebar-new-plus">+</span> New tab
      </button>
      {pinnedTabs.length > 0 && (
        <ul className="pinned-grid">
          {pinnedTabs.map((t) => (
            <PinnedSquare
              key={t.id}
              tab={t}
              active={t.id === activeId}
              dragging={t.id === draggingId}
              dropPos={dropTarget?.id === t.id && t.id !== draggingId ? dropTarget.pos : null}
              onSelect={() => onSelect(t.id)}
              onContextMenu={() => onContextMenu(t.id)}
              onDragStart={() => setDraggingId(t.id)}
              onDragOver={(pos) => setDropTarget({ id: t.id, pos })}
              onDrop={commitDrop}
              onDragEnd={handleDragEnd}
            />
          ))}
        </ul>
      )}
      {/* Folders sit between the pinned grid and the loose tabs. Each folder is a
          header (collapse / rename / remove) plus its tabs when expanded. Right-
          click a tab to move it in/out or create a folder (native menu). */}
      {folders.length > 0 && (
        <div className="tab-folders">
          {folders.map((f) => (
            <div
              className={`tab-folder${dropFolderId === f.id ? ' drop-into' : ''}${
                f.color ? ' has-color' : ''
              }`}
              key={f.id}
              // The accent color drives a left border on the folder (via CSS var).
              style={f.color ? ({ '--folder-color': f.color } as React.CSSProperties) : undefined}
              // The whole folder (header + its tabs) is a drop target for a dragged
              // tab: dropping anywhere on it moves the tab into this folder. Row
              // drops inside still reorder/join via the row handlers (they stop
              // propagation); this catches drops on the header and empty space.
              onDragOver={(e) => {
                if (!draggingId) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setDropFolderId(f.id)
                setDropTarget(null)
              }}
              onDrop={(e) => {
                e.preventDefault()
                dropIntoFolder(f.id)
              }}
            >
              <FolderHeader
                folder={f}
                count={folderTabsOf(f.id).length}
                editing={editingFolderId === f.id}
                onToggle={() => onToggleFolder(f.id)}
                onRename={(title) => onRenameFolder(f.id, title)}
                onRemove={() => onRemoveFolder(f.id)}
                onEditStart={() => setEditingFolderId(f.id)}
                onEditEnd={() => setEditingFolderId(null)}
                onContextMenu={() => onFolderContextMenu(f.id)}
              />
              {!f.collapsed && <ul className="folder-tabs">{folderTabsOf(f.id).map(renderRow)}</ul>}
            </div>
          ))}
        </div>
      )}
      <ul className="tab-list">{looseTabs.map(renderRow)}</ul>
    </nav>
  )
}

export default Sidebar
