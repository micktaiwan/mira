// The browsing-history data model, kept pure and Electron-free so it is fully
// unit-tested — the same split as bookmark-store.ts / tab-store.ts. This file
// owns the list algebra (record a visit, search, recent, normalize); the native
// side (src/main/profiles.ts) owns wiring page navigations to recordVisit and
// persistence (userData/history.json).
//
// History is a flat list of visited urls, most-recent-first, de-duplicated by
// url (a re-visit bumps the existing entry's count and timestamp instead of
// appending a duplicate). It is GLOBAL — one list for the whole app, like the
// favorites tree (see track.md) — but a re-visit / reopen always acts on the
// window that issued the command, so it lands in the right profile.

/** A visited page. `lastVisited` is an epoch-ms timestamp; `visitCount` grows on
 * every re-visit. `title` is the last non-empty title seen for this url. */
export interface HistoryEntry {
  url: string
  title: string
  lastVisited: number
  visitCount: number
}

/** Hard cap on the number of entries kept. On overflow the oldest (tail, since
 * the list is most-recent-first) are dropped. Personal browser, one user — this
 * is plenty and keeps history.json and the palette candidate set bounded. */
export const MAX_HISTORY = 5000

/** Record a visit to `url` at time `at`. If the url is already known, its entry
 * moves to the front, its count increments, its timestamp updates, and its title
 * is refreshed when a non-empty one is given (a page's title arrives after the
 * navigation, so an empty title never clobbers a good one). Otherwise a new
 * entry is prepended. Pure: returns a new list, input untouched. Trimmed to
 * MAX_HISTORY from the tail (oldest). */
export function recordVisit(
  list: HistoryEntry[],
  visit: { url: string; title?: string; at: number }
): HistoryEntry[] {
  const url = visit.url
  const existing = list.find((e) => e.url === url)
  const rest = list.filter((e) => e.url !== url)
  const entry: HistoryEntry = existing
    ? {
        url,
        // Keep the old title unless a fresh non-empty one supersedes it.
        title: visit.title && visit.title.trim() !== '' ? visit.title : existing.title,
        lastVisited: visit.at,
        visitCount: existing.visitCount + 1
      }
    : {
        url,
        title: visit.title ?? '',
        lastVisited: visit.at,
        visitCount: 1
      }
  return [entry, ...rest].slice(0, MAX_HISTORY)
}

/** The `limit` most-recent entries (the head of the list). */
export function recentHistory(list: HistoryEntry[], limit: number): HistoryEntry[] {
  return list.slice(0, Math.max(0, limit))
}

/** Relevance of an entry against a lower-cased query: a title/url prefix beats a
 * substring, matching either the title or the url. 0 = no match. */
function scoreEntry(entry: HistoryEntry, q: string): number {
  const title = entry.title.toLowerCase()
  const url = entry.url.toLowerCase()
  if (title.startsWith(q) || url.startsWith(q)) return 3
  if (title.includes(q) || url.includes(q)) return 2
  return 0
}

/** Entries matching `query` in their title OR url, best matches first, ties
 * broken by recency (the input order, most-recent-first). Empty query → the most
 * recent entries. Capped at `limit`. Pure. */
export function searchHistory(list: HistoryEntry[], query: string, limit = 50): HistoryEntry[] {
  const q = query.trim().toLowerCase()
  if (q === '') return recentHistory(list, limit)
  return list
    .map((e, i) => ({ e, i, s: scoreEntry(e, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, Math.max(0, limit))
    .map((x) => x.e)
}

/** Coerce whatever was parsed from history.json into a valid, de-duplicated list
 * (a url needs a non-empty string; the rest degrades to sane defaults). Keeps the
 * stored order, drops duplicate urls (first wins), never throws — bad input
 * degrades to an empty list. Trimmed to MAX_HISTORY. */
export function normalizeHistory(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return []
  const out: HistoryEntry[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const v = item as Record<string, unknown>
    if (typeof v.url !== 'string' || v.url.trim() === '') continue
    if (seen.has(v.url)) continue
    seen.add(v.url)
    out.push({
      url: v.url,
      title: typeof v.title === 'string' ? v.title : '',
      lastVisited: typeof v.lastVisited === 'number' ? v.lastVisited : 0,
      visitCount:
        typeof v.visitCount === 'number' && v.visitCount > 0 ? Math.floor(v.visitCount) : 1
    })
    if (out.length >= MAX_HISTORY) break
  }
  return out
}
