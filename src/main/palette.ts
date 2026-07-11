// Command palette (Cmd+K) domain logic, kept PURE so it is unit-testable without
// Electron (see the "tout testable" principle in CLAUDE.md). The only real work
// here is turning the app's current state (tabs, favorites, profiles) into a flat
// list of runnable entries; the overlay itself is chrome, and running an entry is
// just a registry command it already knows how to call.
//
// Query filtering is deliberately NOT done here: the chrome fetches the full entry
// list once when the palette opens and fuzzy-filters it locally on every keystroke
// (no IPC round-trip per key). This module only builds the candidate set.

import type { BookmarkNode } from './bookmark-store'

/** Where an entry sorts in the palette; also its section heading. */
export type PaletteGroup = 'Skills' | 'Commands' | 'Tabs' | 'Bookmarks' | 'History' | 'Profiles'

/** One palette row. It maps a human label to a registry command + params, so
 * picking it is just another call onto the same bus as the toolbar and socket. */
export interface PaletteEntry {
  /** Stable, unique id (React key + selection tracking). */
  id: string
  /** Primary label shown in the row. */
  title: string
  /** Secondary text (a url, a profile's open/closed state…), shown dimmed. */
  subtitle?: string
  /** Section this entry belongs to. */
  group: PaletteGroup
  /** The registry command this entry runs when chosen. */
  command: string
  /** Already-resolved params for that command (omitted for no-arg commands). */
  params?: Record<string, unknown>
  /** Extra terms folded into the fuzzy match but not displayed. */
  keywords?: string
  /** Keyboard shortcut shown dimmed at the right of the row (display only — the
   * actual accelerator is registered by the menu, see menu.ts). Mac symbols. */
  shortcut?: string
  /** Present when the entry navigates to a page (history / favorites). The chrome
   * routes it to the current tab or a new one depending on the palette mode and
   * the Cmd modifier (see CommandPalette), rather than running `command`. */
  url?: string
}

/** The slice of app state the palette needs to enumerate its dynamic entries.
 * A minimal view of each domain (not the full TabInfo / profile shapes) so this
 * stays decoupled and easy to fake in tests. */
export interface PaletteState {
  tabs: Array<{ id: string; title: string; url: string; kind: 'web' | 'settings' }>
  activeId: string | null
  bookmarks: BookmarkNode[]
  /** Recent browsing history (most-recent-first), already capped by the caller —
   * the palette fetches a bounded slice, not the whole store. */
  history: Array<{ url: string; title: string }>
  profiles: Array<{ id: string; label: string; open: boolean }>
  focusedProfile: string | null
  /** Skills applicable to the active page (already resolved by the caller from the
   * page url — see commands/palette.ts). Each becomes a "Skills on this page" row
   * that runs `run-skill`. Empty on non-web pages. */
  skills: Array<{ id: string; name: string }>
}

/** The always-present command entries, independent of any window/tab state. Order
 * here is the order they show under the "Commands" group. Shortcuts are display
 * only and must stay in sync with the accelerators registered in menu.ts. */
const STATIC_COMMANDS: ReadonlyArray<Omit<PaletteEntry, 'group'>> = [
  {
    id: 'cmd:new-tab',
    title: 'New Tab',
    command: 'new-tab',
    keywords: 'open create',
    shortcut: '⌘T'
  },
  {
    id: 'cmd:close-tab',
    title: 'Close Tab',
    command: 'close-active-tab',
    keywords: 'quit',
    shortcut: '⌘W'
  },
  { id: 'cmd:reload', title: 'Reload Page', command: 'reload', keywords: 'refresh', shortcut: '⌘R' },
  {
    id: 'cmd:find',
    title: 'Find in Page',
    command: 'find-open',
    keywords: 'search text match locate',
    shortcut: '⌘F'
  },
  { id: 'cmd:back', title: 'Back', command: 'back', keywords: 'history previous', shortcut: '⌘←' },
  {
    id: 'cmd:forward',
    title: 'Forward',
    command: 'forward',
    keywords: 'history next',
    shortcut: '⌘→'
  },
  {
    id: 'cmd:discard-tab',
    title: 'Discard Tab',
    command: 'discard-active-tab',
    keywords: 'sleep unload memory ram',
    shortcut: '⌘S'
  },
  {
    id: 'cmd:toggle-panel',
    title: 'Toggle Tab Panel',
    command: 'toggle-tabs-panel',
    keywords: 'sidebar hide show',
    shortcut: '⌘B'
  },
  {
    id: 'cmd:add-bookmark',
    title: 'Add to Favorites',
    command: 'add-bookmark',
    keywords: 'bookmark star favorite',
    shortcut: '⌘D'
  },
  {
    id: 'cmd:settings',
    title: 'Open Settings',
    command: 'open-settings',
    keywords: 'preferences config options',
    shortcut: '⌘,'
  },
  { id: 'cmd:new-profile', title: 'New Profile', command: 'create-profile', keywords: 'account' },
  {
    id: 'cmd:clear-site-data',
    title: 'Clear Data for This Site',
    command: 'clear-site-data',
    keywords: 'cookies storage logout sign out forget site current page'
  },
  {
    id: 'cmd:clear-data',
    title: 'Clear Browsing Data',
    command: 'clear-data',
    keywords: 'cookies cache storage logout sign out wipe reset all profile'
  }
]

/** Flatten a favorites tree to its url leaves (folders dropped): each becomes an
 * "open this favorite" entry. Recursive, mirroring the tree depth. */
function bookmarkEntries(nodes: BookmarkNode[]): PaletteEntry[] {
  const out: PaletteEntry[] = []
  for (const node of nodes) {
    if (node.kind === 'url' && node.url) {
      out.push({
        id: `bookmark:${node.id}`,
        title: node.title?.trim() || node.url,
        subtitle: node.url,
        group: 'Bookmarks',
        command: 'open-bookmark',
        params: { id: node.id },
        // Navigable: the chrome opens it in the current tab or a new one per the
        // palette mode. `command` stays open-bookmark as the plain fallback.
        url: node.url
      })
    } else if (node.kind === 'folder' && node.children) {
      out.push(...bookmarkEntries(node.children))
    }
  }
  return out
}

/** Build the full palette candidate list from a state snapshot. Pure: same input
 * → same output, no Electron. The chrome filters/ranks this list as the user types.
 *
 * Dynamic entries only offer the OTHER targets (every tab but the active one, every
 * profile but the focused one) — there is nothing to switch to on the current one. */
export function buildPaletteEntries(state: PaletteState): PaletteEntry[] {
  // Skills for the current page lead the list — they are the context-specific
  // actions, most relevant when the palette opens on a real page. Picking one runs
  // run-skill; the chrome shows the result inline (see CommandPalette).
  const skills: PaletteEntry[] = state.skills.map((s) => ({
    id: `skill:${s.id}`,
    title: s.name,
    group: 'Skills',
    command: 'run-skill',
    params: { id: s.id },
    keywords: 'skill ai summarize this page'
  }))

  const commands: PaletteEntry[] = STATIC_COMMANDS.map((c) => ({ ...c, group: 'Commands' }))

  const tabs: PaletteEntry[] = state.tabs
    .filter((t) => t.id !== state.activeId)
    .map((t) => ({
      id: `tab:${t.id}`,
      title: t.title?.trim() || t.url || 'New Tab',
      subtitle: t.kind === 'settings' ? 'Settings' : t.url || undefined,
      group: 'Tabs',
      command: 'select-tab',
      params: { id: t.id },
      keywords: 'switch tab'
    }))

  const bookmarks = bookmarkEntries(state.bookmarks)

  // History entries are navigable (url set) so the chrome routes them to the
  // current tab or a new one like any address; `command` is a plain fallback.
  // Urls already saved as favorites are dropped to avoid a duplicate row.
  const bookmarkedUrls = new Set(bookmarks.map((b) => b.url))
  const history: PaletteEntry[] = state.history
    .filter((h) => !bookmarkedUrls.has(h.url))
    .map((h) => ({
      id: `history:${h.url}`,
      title: h.title?.trim() || h.url,
      subtitle: h.url,
      group: 'History',
      command: 'navigate',
      params: { url: h.url },
      url: h.url
    }))

  const profiles: PaletteEntry[] = state.profiles
    .filter((p) => p.id !== state.focusedProfile)
    .map((p) => ({
      id: `profile:${p.id}`,
      title: `Switch to ${p.label}`,
      subtitle: p.open ? 'open' : 'closed',
      group: 'Profiles',
      command: 'open-profile',
      params: { id: p.id },
      keywords: 'profile account'
    }))

  return [...skills, ...commands, ...tabs, ...bookmarks, ...history, ...profiles]
}
