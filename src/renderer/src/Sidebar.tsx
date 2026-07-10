import { useEffect, useRef, useState, type DragEvent } from 'react'

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

/** Tooltip text for a tab: its title, then its url on a second line (the
 * overlay bubble renders \n — white-space: pre-line in tooltip-doc.ts). */
function tooltipFor(tab: TabInfo): string {
  if (tab.kind === 'settings') return 'Settings'
  const title = tab.title.trim()
  if (title && tab.url) return `${title}\n${tab.url}`
  return tab.url || title || 'New tab'
}

/** How long the cursor must rest on a tab before its tooltip shows (same feel
 * as the status bar's items). */
const TOOLTIP_DELAY_MS = 150

/** Hover wiring for the tab tooltips. They cannot be DOM bubbles: a bubble
 * would overflow the panel into the region the active tab's WebContentsView
 * covers, and that native layer paints above the chrome's DOM (CLAUDE.md, "les
 * deux pièges") — the native title="" attribute is broken on this Electron
 * besides. So, like the status bar, hovering asks main (via the registry) to
 * show the floating overlay window. One instance owned by the Sidebar. */
function useTabTooltip(): { enter: (el: HTMLElement, text: string) => void; leave: () => void } {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Never leave a bubble up if the panel unmounts mid-hover (panel collapsed).
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
      void window.mira.command('hide-tooltip')
    }
  }, [])
  const enter = (el: HTMLElement, text: string): void => {
    if (timer.current) clearTimeout(timer.current)
    // Capture the element now — the timer fires after React recycled the event.
    timer.current = setTimeout(() => {
      const r = el.getBoundingClientRect()
      void window.mira.command('show-tooltip', {
        text,
        anchor: { x: r.left, y: r.top, width: r.width, height: r.height }
      })
    }, TOOLTIP_DELAY_MS)
  }
  const leave = (): void => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    void window.mira.command('hide-tooltip')
  }
  return { enter, leave }
}

type DropPos = 'before' | 'after'

// One pinned tab: a compact square (favicon only) in the wrapping grid at the
// head of the strip. Click selects it. Deliberately no close button — Cmd+W
// pressed twice in a row closes a pinned tab. Drag reorders within the pinned
// block (the grid flows horizontally, so the drop line is left/right, not
// top/bottom). Right-click unpins (the tab drops back to the head of the list).
function PinnedSquare({
  tab,
  active,
  dragging,
  dropPos,
  onSelect,
  onUnpin,
  onHover,
  onLeave,
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
  onUnpin: () => void
  onHover: (el: HTMLElement) => void
  onLeave: () => void
  onDragStart: () => void
  onDragOver: (pos: DropPos) => void
  onDrop: () => void
  onDragEnd: () => void
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
        onUnpin()
      }}
      onMouseEnter={(e) => onHover(e.currentTarget)}
      onMouseLeave={onLeave}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', tab.id)
        // No tooltip bubble riding along under the drag ghost.
        onLeave()
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
  onClose,
  onPin,
  onHover,
  onLeave,
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
  onClose: () => void
  onPin: () => void
  onHover: (el: HTMLElement) => void
  onLeave: () => void
  onDragStart: () => void
  onDragOver: (pos: DropPos) => void
  onDrop: () => void
  onDragEnd: () => void
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
      onClick={onSelect}
      onMouseEnter={(e) => onHover(e.currentTarget)}
      onMouseLeave={onLeave}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', tab.id)
        // No bubble riding along under the drag ghost.
        onLeave()
        onDragStart()
      }}
      onDragOver={(e: DragEvent<HTMLLIElement>) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const rect = e.currentTarget.getBoundingClientRect()
        onDragOver(e.clientY < rect.top + rect.height / 2 ? 'before' : 'after')
      }}
      onDrop={(e) => {
        e.preventDefault()
        onDrop()
      }}
      onDragEnd={onDragEnd}
    >
      <Favicon tab={tab} />
      <span className="tab-title">
        {isSettings ? 'Settings' : tab.title || tab.url || 'New tab'}
      </span>
      <button
        type="button"
        className="tab-pin"
        aria-label="Pin tab"
        title="Pin tab"
        onClick={(e) => {
          e.stopPropagation()
          onPin()
        }}
      >
        📌
      </button>
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
  onNew,
  onMove,
  onPin,
  onUnpin
}: {
  tabs: TabInfo[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  onMove: (id: string, toIndex: number) => void
  onPin: (id: string) => void
  onUnpin: (id: string) => void
}): React.JSX.Element {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; pos: DropPos } | null>(null)
  const tooltip = useTabTooltip()

  // Pinned tabs form a contiguous block at the head of the strip (a tab-store
  // invariant); the grid and the row list are just the two halves of `tabs`.
  const pinnedTabs = tabs.filter((t) => t.pinned)
  const regularTabs = tabs.filter((t) => !t.pinned)

  const reset = (): void => {
    setDraggingId(null)
    setDropTarget(null)
  }

  const commitDrop = (): void => {
    if (draggingId && dropTarget) {
      const from = tabs.findIndex((t) => t.id === draggingId)
      const over = tabs.findIndex((t) => t.id === dropTarget.id)
      if (from !== -1 && over !== -1) {
        // Index in the current order where the tab should land...
        const insertBefore = dropTarget.pos === 'before' ? over : over + 1
        // ...converted to its final index once the dragged tab is removed.
        const toIndex = from < insertBefore ? insertBefore - 1 : insertBefore
        if (toIndex !== from) onMove(draggingId, toIndex)
      }
    }
    reset()
  }

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
              onUnpin={() => onUnpin(t.id)}
              onHover={(el) => tooltip.enter(el, tooltipFor(t))}
              onLeave={tooltip.leave}
              onDragStart={() => setDraggingId(t.id)}
              onDragOver={(pos) => setDropTarget({ id: t.id, pos })}
              onDrop={commitDrop}
              onDragEnd={reset}
            />
          ))}
        </ul>
      )}
      <ul className="tab-list">
        {regularTabs.map((t) => (
          <TabRow
            key={t.id}
            tab={t}
            active={t.id === activeId}
            dragging={t.id === draggingId}
            dropPos={dropTarget?.id === t.id && t.id !== draggingId ? dropTarget.pos : null}
            onSelect={() => onSelect(t.id)}
            onClose={() => onClose(t.id)}
            onPin={() => onPin(t.id)}
            onHover={(el) => tooltip.enter(el, tooltipFor(t))}
            onLeave={tooltip.leave}
            onDragStart={() => setDraggingId(t.id)}
            onDragOver={(pos) => setDropTarget({ id: t.id, pos })}
            onDrop={commitDrop}
            onDragEnd={reset}
          />
        ))}
      </ul>
    </nav>
  )
}

export default Sidebar
