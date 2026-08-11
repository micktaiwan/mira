import { useRef, useState, type DragEvent } from 'react'
import FolderHeader, { type TabFolder } from './features/tab-folders/FolderHeader'
import {
  nearestGridTarget,
  nearestVerticalTarget,
  planDrop,
  planFolderDrop,
  sameDropZone,
  type DropPos,
  type DropTarget,
  type TabBox
} from './sidebar-drag'

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
  /** Whether the tab is currently playing sound: shows a speaker icon on the row
   * (and the pinned square). Live runtime flag, not persisted. */
  audible: boolean
  /** Whether the tab's main frame is currently loading. Live runtime flag, not
   * persisted; drives the toolbar reload spinner. */
  loading: boolean
}

/** The speaker icon shown on a tab that is emitting sound. A monochrome inline
 * SVG (currentColor) to match Mira's glyph chrome — no colored emoji. Rendered in
 * the row (after the title) and as a corner badge on pinned squares. */
function AudioIcon(): React.JSX.Element {
  return (
    <span className="tab-audio" aria-label="Playing audio" title="Playing audio">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M8 2.6 4.4 5.5H1.9v5h2.5L8 13.4z" fill="currentColor" />
        <path
          d="M10.6 6a2.6 2.6 0 0 1 0 4"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
        <path
          d="M12.3 4.1a5 5 0 0 1 0 7.8"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
    </span>
  )
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

/** The on-screen boxes of the tabs a container holds, read from the DOM via the
 * `data-tab-id` every row and pinned tile carries. Feeds the nearest-target
 * resolvers so a drop in a gap / in the padding / under the last row still means
 * something. */
function tabBoxesIn(container: HTMLElement): TabBox[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-tab-id]')).map((el) => {
    const r = el.getBoundingClientRect()
    return {
      id: el.dataset.tabId ?? '',
      top: r.top,
      bottom: r.bottom,
      left: r.left,
      right: r.right
    }
  })
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
      // Same marker as a tab row: it lets the grid resolve a pointer that falls in
      // one of its gaps to the nearest tile. Main's cross-window hit-test only
      // looks at `.tab-row[data-tab-id]`, so a pinned tile never matches it.
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
        // Let the tile's own before/after win over the grid's gap resolution.
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        const rect = e.currentTarget.getBoundingClientRect()
        onDragOver(e.clientX < rect.left + rect.width / 2 ? 'before' : 'after')
      }}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onDrop()
      }}
      onDragEnd={onDragEnd}
    >
      <Favicon tab={tab} />
      {tab.audible && <AudioIcon />}
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
      {tab.audible && <AudioIcon />}
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
  editingFolderId,
  onEditFolderStart,
  onEditFolderEnd,
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
  /** The folder whose name field is open (null = none). App-owned, because main
   * asks for it on an interactive create ("New Folder…" can't prompt for text). */
  editingFolderId: string | null
  /** Open a folder's name field (double-click on its header). */
  onEditFolderStart: (id: string) => void
  /** Close the open name field (blur / Enter / Escape). */
  onEditFolderEnd: () => void
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
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  // The folder header a dragged tab is hovering (drop = move that tab into it).
  const [dropFolderId, setDropFolderId] = useState<string | null>(null)
  // Whether a drop was handled inside this sidebar, read by dragEnd to tell a real
  // tear-off from a drop it already committed. A ref, not state: dragEnd fires
  // right after drop and React may not have flushed the reset by then.
  const droppedInside = useRef(false)

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

  const beginDrag = (id: string): void => {
    droppedInside.current = false
    setDraggingId(id)
  }

  // The two drop intents are exclusive: aiming at a slot cancels the folder
  // highlight, and aiming at a folder cancels the slot. Going through these two
  // setters (never setDropTarget/setDropFolderId directly) is what keeps a single
  // indicator on screen and a single meaning at drop time.
  const aimAtSlot = (target: DropTarget | null): void => {
    setDropTarget(target)
    setDropFolderId(null)
  }

  const aimAtFolder = (folderId: string): void => {
    setDropFolderId(folderId)
    setDropTarget(null)
  }

  // End of a tab drag. When the tab was dropped OUTSIDE this window's frame (another
  // screen, the desktop, or over another Mira window), tear it off — HTML5 drag can't
  // cross OS windows, so we detect it here from the drop's screen coordinates and hand
  // them to main, which opens a new window there or re-attaches onto the window under
  // the point.
  const handleDragEnd = (e: DragEvent<HTMLLIElement>): void => {
    const id = draggingId
    // Chromium sometimes reports (0,0) on dragend: that is not a drop point, and
    // reading it as one would tear the tab off to the top-left of the screen.
    const knownPoint = e.screenX !== 0 || e.screenY !== 0
    const outside =
      e.screenX < window.screenX ||
      e.screenX > window.screenX + window.outerWidth ||
      e.screenY < window.screenY ||
      e.screenY > window.screenY + window.outerHeight
    // A drop the sidebar already committed is never a tear-off, whatever the
    // coordinates say — droppedInside is set synchronously by the drop handlers.
    if (id && knownPoint && outside && !droppedInside.current) onDetach(id, e.screenX, e.screenY)
    reset()
  }

  // Apply a resolved plan. Every drop path funnels through here so they all mark
  // the drag as consumed (see droppedInside) and reset the same way.
  const commitPlan = (plan: ReturnType<typeof planDrop>): void => {
    if (plan) {
      if (plan.moveToFolder) onMoveTabToFolder(plan.moveToFolder.tabId, plan.moveToFolder.folderId)
      if (plan.move) onMove(plan.move.id, plan.move.toIndex)
    }
    droppedInside.current = true
    reset()
  }

  // Drop on a slot (a row/tile edge, or the nearest one when the pointer was in a
  // gap). planDrop owns the math AND the pinned-boundary guard: a cross-boundary
  // drop returns null (a clean no-op) instead of a store-clamped surprise.
  const commitDrop = (): void => {
    commitPlan(draggingId && dropTarget ? planDrop(tabs, draggingId, dropTarget) : null)
  }

  // Drop on a folder itself (header or its own surface): join it and append to its
  // block — see planFolderDrop for why membership alone is not enough.
  const commitFolderDrop = (folderId: string): void => {
    commitPlan(draggingId ? planFolderDrop(tabs, draggingId, folderId) : null)
  }

  // Drop in the loose list with nothing to aim at (it is empty): the gesture still
  // means "take this tab out of its folder".
  const commitLooseDrop = (): void => {
    if (dropTarget) return commitDrop()
    const dragged = draggingId ? tabs.find((t) => t.id === draggingId) : null
    if (dragged && !dragged.pinned && dragged.folderId !== null) onMoveTabToFolder(dragged.id, null)
    droppedInside.current = true
    reset()
  }

  // Aim at a hovered tab — but only when it shares the dragged tab's zone. A
  // cross-boundary hover (pinned tile over a regular row, or the reverse) CLEARS
  // the aim instead of leaving the previous slot armed: otherwise releasing here
  // would commit a drop the cursor no longer points at, and could reorder the
  // pinned block that planDrop's boundary guard exists to protect.
  const setDropOn = (target: TabInfo, pos: DropPos): void => {
    const dragged = draggingId ? tabs.find((t) => t.id === draggingId) : null
    if (dragged && !sameDropZone(dragged, target)) return aimAtSlot(null)
    aimAtSlot({ id: target.id, pos })
  }

  // The dragged tab, when it is a regular one — the guard every container-level
  // handler shares (a pinned tile belongs to the grid and to nothing else).
  const draggedRegularTab = (): TabInfo | null => {
    const dragged = draggingId ? tabs.find((t) => t.id === draggingId) : null
    return dragged && !dragged.pinned ? dragged : null
  }

  // dragOver on a list of rows (a folder's tabs, or the loose list): resolve the
  // pointer to the nearest row edge, so the gaps, the padding and the empty space
  // under the last row stop being dead zones. `catchAll` keeps the loose list a
  // drop target even when it holds no row to aim at.
  const listDragOver = (e: DragEvent<HTMLUListElement>, catchAll: boolean): void => {
    if (!draggedRegularTab()) return
    const target = nearestVerticalTarget(tabBoxesIn(e.currentTarget), e.clientY)
    if (!target && !catchAll) return
    e.preventDefault()
    // Inside a folder, keep the wrapper's "drop into this folder" from taking over
    // a pointer that clearly means a slot.
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    aimAtSlot(target)
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
      onDragStart={() => beginDrag(t.id)}
      onDragOver={(pos) => setDropOn(t, pos)}
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
        <ul
          className="pinned-grid"
          // Everything of the grid that is not a tile — the 4px gaps between them,
          // the trailing space of a wrapped line — is a drop surface too. Tiles
          // stopPropagation, so this fires only for those, and it resolves the
          // pointer to the nearest tile's edge (NOT "the end of the block", which
          // used to send a tile last from a 4px slip of the mouse). Guarded to
          // pinned drags — a regular tab can't land here.
          onDragOver={(e) => {
            const dragged = draggingId ? tabs.find((t) => t.id === draggingId) : null
            if (!dragged?.pinned) return
            const target = nearestGridTarget(tabBoxesIn(e.currentTarget), e.clientX, e.clientY)
            if (!target) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            aimAtSlot(target)
          }}
          onDrop={(e) => {
            e.preventDefault()
            commitDrop()
          }}
        >
          {pinnedTabs.map((t) => (
            <PinnedSquare
              key={t.id}
              tab={t}
              active={t.id === activeId}
              dragging={t.id === draggingId}
              dropPos={dropTarget?.id === t.id && t.id !== draggingId ? dropTarget.pos : null}
              onSelect={() => onSelect(t.id)}
              onContextMenu={() => onContextMenu(t.id)}
              onDragStart={() => beginDrag(t.id)}
              onDragOver={(pos) => setDropOn(t, pos)}
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
              // The folder header (and any of the wrapper's own surface) is a drop
              // target: dropping there moves the tab into this folder, appended to
              // its block. Its rows and its tab list handle their own drops and stop
              // propagation, so this only catches what they leave.
              onDragOver={(e) => {
                // A pinned tab never enters a folder (main no-ops it) — don't
                // highlight the folder as a drop target for one.
                if (!draggedRegularTab()) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                aimAtFolder(f.id)
              }}
              onDrop={(e) => {
                e.preventDefault()
                commitFolderDrop(f.id)
              }}
            >
              <FolderHeader
                folder={f}
                count={folderTabsOf(f.id).length}
                editing={editingFolderId === f.id}
                onToggle={() => onToggleFolder(f.id)}
                onRename={(title) => onRenameFolder(f.id, title)}
                onRemove={() => onRemoveFolder(f.id)}
                onEditStart={() => onEditFolderStart(f.id)}
                onEditEnd={onEditFolderEnd}
                onContextMenu={() => onFolderContextMenu(f.id)}
              />
              {!f.collapsed && (
                <ul
                  className="folder-tabs"
                  // The list's own surface (its 10px left indent, the gaps between
                  // rows) means a slot inside the folder, not "join the folder" —
                  // without this, dragging along a folder's left edge silently turned
                  // a reorder into a membership change.
                  onDragOver={(e) => listDragOver(e, false)}
                  onDrop={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    commitDrop()
                  }}
                >
                  {folderTabsOf(f.id).map(renderRow)}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
      {/* A visible rule between the folders section and the loose tabs, so the
          two groups read as distinct. Only when both sides have content. */}
      {folders.length > 0 && looseTabs.length > 0 && (
        <div className="tab-folders-divider" role="separator" />
      )}
      {/* The loose list stretches to the bottom of the sidebar (see .tab-list in
          main.css), so the empty space under the last tab is part of it: dropping
          there sends the tab to the end of the list instead of doing nothing. */}
      <ul
        className="tab-list"
        onDragOver={(e) => listDragOver(e, true)}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          commitLooseDrop()
        }}
      >
        {looseTabs.map(renderRow)}
      </ul>
    </nav>
  )
}

export default Sidebar
