// Pure list logic behind the command palette: which rows a query yields, in which
// order. No React here on purpose — this is the testable half of the palette (see
// "tout testable" in CLAUDE.md), leaving CommandPalette.tsx as rendering + input
// handling only. It also keeps that component file exporting a component alone,
// which is what react-refresh needs to hot-reload it.

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
export type PaletteMode = 'launcher' | 'address'

/** In address mode the palette is an address bar: only navigation targets belong
 * (history / favorites / open tabs), not commands or profile switches. */
const ADDRESS_GROUPS = new Set<PaletteEntry['group']>(['History', 'Bookmarks', 'Tabs'])

/** The synthetic "open exactly what you typed" row. Its url is the raw query;
 * `navigate` normalizes it (a bare domain → https, otherwise a search), so this
 * covers both "go to a site" and "search the web". */
export function goToEntry(query: string): PaletteEntry {
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

/** The rows a query yields, in display order.
 *
 * Both modes offer the synthetic "go to / search" row on a non-empty query, but
 * at opposite ends. Address mode leads with it: the bar's whole job is to go
 * somewhere, so Enter on what you typed must be the default. Launcher mode
 * trails it, so a matching command or tab still wins Enter and the search row is
 * the fallback — including when nothing matches and it is the only row, which is
 * what lets Cmd+K search the web at all. */
export function buildPaletteList(
  entries: PaletteEntry[],
  query: string,
  mode: PaletteMode
): PaletteEntry[] {
  // Address mode narrows to navigation targets; launcher lists everything.
  const source = mode === 'address' ? entries.filter((e) => ADDRESS_GROUPS.has(e.group)) : entries
  const ranked = filterEntries(source, query)
  if (query.trim() === '') return ranked
  const go = goToEntry(query)
  return mode === 'address' ? [go, ...ranked] : [...ranked, go]
}
