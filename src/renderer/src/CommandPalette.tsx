import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

/** One palette row (mirrors PaletteEntry in the main-process registry). Running it
 * is just a registry command, so the chrome holds no palette logic of its own.
 * A `url` marks a navigable row (history / favorite / the typed address): the
 * chrome opens it in the current tab or a new one per mode + Cmd, instead of
 * running `command`. */
export interface PaletteEntry {
  id: string
  title: string
  subtitle?: string
  group: 'Skills' | 'Commands' | 'Tabs' | 'Bookmarks' | 'History' | 'Profiles'
  command: string
  params?: Record<string, unknown>
  keywords?: string
  url?: string
  shortcut?: string
}

/** How the palette was opened, which sets the DEFAULT target of a page pick:
 * 'launcher' (Cmd+K) opens a new tab; 'address' (typed in the URL bar) navigates
 * the current tab. Cmd+Enter / Cmd+click flips it either way. */
type PaletteMode = 'launcher' | 'address'

interface Props {
  /** Dismiss the palette (Esc, backdrop click, or after a pick). The parent tells
   * main to close, which re-shows the web view (main owns the open state). */
  onClose: () => void
  /** Where the palette was opened from — decides the default pick target. */
  mode: PaletteMode
  /** Seed text (what was typed in the URL bar, empty for Cmd+K). */
  initialQuery: string
}

/** In address mode the palette is an address bar: only navigation targets belong
 * (history / favorites / open tabs), not commands or profile switches. */
const ADDRESS_GROUPS = new Set<PaletteEntry['group']>(['History', 'Bookmarks', 'Tabs'])

/** Leading glyph per group — pure decoration; the color accent comes from CSS
 * keyed on the row's data-group attribute. */
const GROUP_ICONS: Record<PaletteEntry['group'], string> = {
  Skills: '✦',
  Commands: '⌘',
  Tabs: '▢',
  Bookmarks: '★',
  History: '↺',
  Profiles: '◉'
}

/** The synthetic top row in address mode: "open exactly what you typed". Its url
 * is the raw query; `navigate` normalizes it (a bare domain → https, otherwise a
 * search), so this covers both "go to a site" and "search the web". */
function goToEntry(query: string): PaletteEntry {
  const q = query.trim()
  return {
    id: 'address:go',
    title: q,
    subtitle: 'Search or open address',
    group: 'History',
    command: 'navigate',
    params: { url: q },
    url: q
  }
}

/** Relevance score of an entry against the lower-cased query: a title prefix beats
 * a title substring beats a match anywhere in the searchable text. 0 = no match. */
function score(entry: PaletteEntry, q: string): number {
  const title = entry.title.toLowerCase()
  if (title.startsWith(q)) return 3
  if (title.includes(q)) return 2
  const hay =
    `${title} ${entry.subtitle ?? ''} ${entry.keywords ?? ''} ${entry.group}`.toLowerCase()
  return hay.includes(q) ? 1 : 0
}

/** Filter + rank entries for a query. Empty query keeps the source order; a query
 * ranks the best matches first, ties broken by source order (a stable sort). */
function filterEntries(entries: PaletteEntry[], query: string): PaletteEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return entries
  return entries
    .map((e, i) => ({ e, i, s: score(e, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.e)
}

/** The command palette: a searchable overlay listing runnable actions and
 * navigation targets. Picking one runs its registry command on the same bus as
 * the toolbar and socket.
 *
 * Two modes share this surface (see CLAUDE.md "tout pilotable"): 'launcher' (Cmd+K)
 * lists everything and opens picked pages in a NEW tab; 'address' (typed in the URL
 * bar) lists only navigation targets, prepends a "go to / search" row, and opens
 * picks in the CURRENT tab. Cmd+Enter (or Cmd+click) flips the target in both.
 *
 * The parent mounts this only while open, so its state starts fresh each opening. */
function CommandPalette({ onClose, mode, initialQuery }: Props): React.JSX.Element {
  const [entries, setEntries] = useState<PaletteEntry[]>([])
  const [query, setQuery] = useState(initialQuery)
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const selectedRef = useRef<HTMLButtonElement>(null)

  // Focus the input SYNCHRONOUSLY on mount (before the browser paints), caret at
  // the end so the seeded query can be extended. useLayoutEffect (not rAF) is what
  // makes the address-bar handoff lossless: the palette input takes over keystrokes
  // the instant it mounts, before the next key can land in the address bar behind it.
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    const end = el.value.length
    el.setSelectionRange(end, end)
  }, [])

  // Fetch the current entries once per opening (tabs / favorites / history change).
  useEffect(() => {
    void (async () => {
      const res = (await window.mira.command('list-palette')) as {
        ok: boolean
        entries?: PaletteEntry[]
      }
      if (res.ok) setEntries(res.entries ?? [])
    })()
  }, [])

  const filtered = useMemo(() => {
    // Address mode narrows to navigation targets and prepends the "go to" row.
    const source = mode === 'address' ? entries.filter((e) => ADDRESS_GROUPS.has(e.group)) : entries
    const ranked = filterEntries(source, query)
    if (mode === 'address' && query.trim() !== '') return [goToEntry(query), ...ranked]
    return ranked
  }, [entries, query, mode])

  // Clamp the selection at read time so a shrinking list never leaves it out of
  // range (avoids a setState-in-effect just to re-clamp).
  const active = filtered.length ? Math.min(selected, filtered.length - 1) : 0

  // Keep the selected row visible as the selection moves (a DOM side effect).
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [active])

  // Run a pick. `forceNewTab` (Cmd held) flips the mode's default target. A
  // navigable row (url set) goes through `navigate` (which normalizes and can open
  // a new tab); a plain row just runs its command.
  const runEntry = (entry: PaletteEntry, forceNewTab: boolean): void => {
    // Close first (re-shows the web view), then run so a navigate / select-tab
    // lands on a visible view. A skill is fire-and-forget: run-skill opens the
    // right pane and streams its own loading → result there (see SkillPane).
    onClose()
    if (entry.command === 'run-skill') {
      void window.mira.command('run-skill', entry.params)
    } else if (entry.url !== undefined) {
      const defaultNewTab = mode === 'launcher'
      const useNewTab = forceNewTab ? !defaultNewTab : defaultNewTab
      void window.mira.command('navigate', { url: entry.url, newTab: useNewTab })
    } else {
      void window.mira.command(entry.command, entry.params)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected(Math.min(active + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected(Math.max(active - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const entry = filtered[active]
      // Cmd+Enter opens in the opposite target (new tab ↔ current tab).
      if (entry) runEntry(entry, e.metaKey)
    }
  }

  const placeholder =
    mode === 'address' ? 'Search or enter address' : 'Type a command, tab, or favorite…'

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      {/* Stop the box's own mousedown from bubbling to the backdrop (which closes). */}
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          type="text"
          placeholder={placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setSelected(0)
          }}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
        />
        <div className="palette-list">
          {filtered.length === 0 ? (
            <div className="palette-empty">No matches</div>
          ) : (
            filtered.map((entry, i) => (
              <button
                key={entry.id}
                ref={i === active ? selectedRef : undefined}
                type="button"
                className={`palette-row${i === active ? ' selected' : ''}`}
                data-group={entry.group.toLowerCase()}
                // Hover selects, so mouse and keyboard share one highlight.
                onMouseMove={() => setSelected(i)}
                onClick={(e) => runEntry(entry, e.metaKey)}
              >
                <span className="palette-icon" aria-hidden="true">
                  {entry.id === 'address:go' ? '↵' : GROUP_ICONS[entry.group]}
                </span>
                <span className="palette-row-main">
                  <span className="palette-title">{entry.title}</span>
                  {entry.subtitle && <span className="palette-subtitle">{entry.subtitle}</span>}
                </span>
                {entry.shortcut && <span className="palette-shortcut">{entry.shortcut}</span>}
                <span className="palette-group-tag">
                  {entry.id === 'address:go' ? '↵' : entry.group}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

export default CommandPalette
