// Auto-sleep: put a tab to sleep (discard its page, keep the tab) once nobody has
// looked at it for a long time, so loaded tabs no longer pile up over the days.
// Each loaded tab is at least one renderer process; left alone, a window grew to
// a hundred of them and the machine ran out of memory.
//
// The rules, all pure and tested here; profiles.ts only runs the sweep:
// - idle = time since the tab was last on screen. `lastActiveAt` only says when it
//   was brought to the front, not when it was left (a tab read from 8:00 to 19:00
//   would count from 8:00), so the sweep also records, in memory, when each tab
//   was last the active one (`seenAt`) and the latest of the two wins. A tab never
//   made active counts from its opening (a tab an agent opened in the background
//   has no `lastActiveAt`; without the fallback it would sleep right away). A tab
//   with no stamp at all has an unknown age and is left alone.
// - never: the active tab, a pinned tab, a keep-awake tab (same exclusions as
//   "Sleep All Except Pinned", tabsToSleep), a tab playing sound right now.
// - never a page holding text the user typed and has not sent: the user typed in
//   it since its last page load AND a field still holds text (see PAGE_TEXT_PROBE).

import type { TabMeta, TabState } from './tab-store'

/** How long a tab may go unseen before it sleeps. */
export const AUTO_SLEEP_IDLE_MS = 12 * 60 * 60 * 1000

/** How often the sweep runs. Coarse on purpose: the idle delay is hours. */
export const AUTO_SLEEP_SWEEP_MS = 10 * 60 * 1000

/** When the tab was last in use, or null when its age is unknown. `seenAt` is
 * the sweep's own record of the last time the tab was the active one. */
export function lastUsedAt(tab: TabMeta, seenAt?: number): number | null {
  const stamp = tab.lastActiveAt ?? tab.openedAt
  if (stamp === undefined) return seenAt ?? null
  return seenAt === undefined ? stamp : Math.max(stamp, seenAt)
}

/**
 * The loaded tabs of one window that have been idle past `idleMs` and are not
 * protected by a rule. `loaded` = ids that currently have a live view, `audible`
 * = ids playing sound now, `seenAt` = id → last time the sweep saw it active.
 * Strip order. The typed-text rule needs the page, so
 * it is applied afterwards by the caller (keepForText).
 */
export function autoSleepCandidates(
  state: TabState,
  loaded: ReadonlySet<string>,
  audible: ReadonlySet<string>,
  seenAt: ReadonlyMap<string, number>,
  now: number,
  idleMs: number = AUTO_SLEEP_IDLE_MS
): string[] {
  return state.tabs
    .filter((t) => {
      if (!loaded.has(t.id) || t.id === state.activeId) return false
      if (t.pinned === true || t.keepAwake === true || audible.has(t.id)) return false
      const used = lastUsedAt(t, seenAt.get(t.id))
      return used !== null && now - used >= idleMs
    })
    .map((t) => t.id)
}

/** Whether a keyboard event is the user typing text into the page (a printable
 * character, Backspace or Delete, without Cmd/Ctrl), as opposed to a shortcut or
 * a navigation key. Shape of Electron's `before-input-event` input. */
export function isTypingInput(input: {
  type: string
  key: string
  meta?: boolean
  control?: boolean
}): boolean {
  if (input.type !== 'keyDown' || input.meta === true || input.control === true) return false
  return input.key.length === 1 || input.key === 'Backspace' || input.key === 'Delete'
}

/** Page-side check, run only on a candidate the user typed in: does any field
 * still hold text? A text input or textarea whose value differs from what the
 * page loaded with, or a non-empty editable region (a chat composer, a mail
 * body). Returns a boolean; it reads, never writes. */
export const PAGE_TEXT_PROBE = `(() => {
  const textTypes = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'number', 'password'])
  for (const el of document.querySelectorAll('input, textarea')) {
    if (el.tagName === 'INPUT' && !textTypes.has((el.getAttribute('type') || '').toLowerCase())) continue
    if (el.value !== '' && el.value !== el.defaultValue) return true
  }
  for (const el of document.querySelectorAll('[contenteditable]:not([contenteditable="false"])')) {
    if (el.isContentEditable && (el.textContent || '').trim() !== '') return true
  }
  return false
})()`

/** Whether a candidate must stay awake for its unsent text. `typed` = the user
 * typed in the tab since its last page load; `probe` = what PAGE_TEXT_PROBE
 * returned, or an Error when the page could not answer. A page that did not
 * answer is kept: losing typed text is worse than keeping a tab awake. */
export function keepForText(typed: boolean, probe: unknown): boolean {
  if (!typed) return false
  return probe !== false
}
