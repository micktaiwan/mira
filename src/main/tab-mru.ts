// The recently-viewed-tabs (MRU) navigation model, pure and Electron-free — the
// testable half of the "back/forward through the tabs I've looked at" feature.
// Separate from tab-store.ts (which owns the strip ORDER): this owns the FOCUS
// history, i.e. the order in which tabs were activated, so Cmd+Alt+Left /
// Cmd+Alt+Right can walk it like a browser's page back/forward — but between
// tabs, per window.
//
// It is a classic back/forward stack with two twists Mickael asked for:
//  - Deduplicated: a tab id appears at most once. Re-viewing a tab moves it to
//    the newest end rather than adding a second entry.
//  - Forward branch is dropped on a fresh visit (standard back/forward): after
//    stepping back and then activating some other tab, the tabs you had stepped
//    back from are discarded.

/** The focus history of one window. `ids` is oldest-first, newest-last, with no
 * duplicates. `cursor` is the index in `ids` of the tab currently shown (so
 * `ids[cursor]` mirrors the window's active tab), or -1 when the history is
 * empty. Stepping back moves the cursor toward 0; forward toward the end. */
export interface MruHistory {
  ids: string[]
  cursor: number
}

export function emptyMru(): MruHistory {
  return { ids: [], cursor: -1 }
}

/** Record a fresh visit to `id` (the window just activated this tab through a
 * normal path — click, Cmd+Up/Down, palette, a new tab). Not called for the
 * cursor moves that back/forward navigation itself makes.
 *
 * - Re-recording the tab already at the cursor is a no-op (no dup, no move).
 * - Otherwise the forward branch (anything after the cursor) is dropped, any
 *   earlier occurrence of `id` is removed (dedup), and `id` is appended as the
 *   new newest entry with the cursor landing on it. */
export function mruRecord(mru: MruHistory, id: string): MruHistory {
  if (mru.ids[mru.cursor] === id) return mru
  const ids = mru.ids.slice(0, mru.cursor + 1).filter((x) => x !== id)
  ids.push(id)
  return { ids, cursor: ids.length - 1 }
}

/** Step the cursor one entry: -1 = back (an older, previously-viewed tab), +1 =
 * forward (a newer one). Returns the moved history plus the id now under the
 * cursor, or `{ mru unchanged, id: null }` when already at that end (no wrap). */
export function mruStep(
  mru: MruHistory,
  direction: 1 | -1
): { mru: MruHistory; id: string | null } {
  const next = mru.cursor + direction
  if (next < 0 || next >= mru.ids.length) return { mru, id: null }
  return { mru: { ids: mru.ids, cursor: next }, id: mru.ids[next] }
}

/** Drop `id` from the history entirely — the tab left the window (closed or torn
 * off), so it must never be a back/forward target again. The cursor is kept on
 * the same surviving entry: shifted left when the removed one sat at or before
 * it, and clamped into the new range. No-op when `id` is not in the history. */
export function mruPrune(mru: MruHistory, id: string): MruHistory {
  const idx = mru.ids.indexOf(id)
  if (idx === -1) return mru
  const ids = mru.ids.slice(0, idx).concat(mru.ids.slice(idx + 1))
  if (ids.length === 0) return { ids, cursor: -1 }
  let cursor = mru.cursor
  if (idx < cursor) cursor -= 1
  if (cursor > ids.length - 1) cursor = ids.length - 1
  return { ids, cursor }
}
