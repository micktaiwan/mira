// The right-click menu shown on a tab in the sidebar. Like page-menu.ts, the
// popup itself is thin and NATIVE (in profiles.ts) — a CSS popover over a tab row
// could be clipped by the WebContentsView (CLAUDE.md "les deux pièges" #3), and a
// native menu always composites above it. This pure, testable function decides
// WHICH items to show for a given tab.
//
// Mira actions are emitted as `command` items so they route through the same
// registry bus as the toolbar and the socket ("tout pilotable"). Duplicate is a
// special item: it targets the CLICKED tab, but the only duplicate command today
// acts on the active tab, so the popup selects the tab first (the popup knows the
// id; this function does not need to carry it).
//
// Tab folders plug in here: a "Move to Folder" submenu (existing folders + New
// Folder) and, when the tab is already in a folder, "Remove from Folder". Folder
// items are hidden for a pinned tab (a pinned tab is never in a folder).

/** The tab a right-click landed on: enough to label Pin vs Unpin, offer the
 * folder actions, and target the id-taking commands. */
export interface TabMenuTarget {
  id: string
  pinned: boolean
  /** Whether the tab is kept awake (never sleeps): picks the Keep Awake vs Stop
   * Keeping Awake label. */
  keepAwake: boolean
  /** The folder the tab is currently in, or null when loose. */
  folderId: string | null
}

/** A folder as the menu needs it (to list "Move to Folder" targets). */
export interface TabMenuFolder {
  id: string
  title: string
}

/** One entry of the resolved tab menu. `command` routes through the registry;
 * `duplicate` is the select-then-duplicate special case; `submenu` nests items;
 * `separator` is a divider. */
export type TabMenuItem =
  | { type: 'separator' }
  | {
      type: 'command'
      command: string
      params?: Record<string, unknown>
      label: string
      enabled: boolean
    }
  | { type: 'duplicate'; label: string }
  | { type: 'submenu'; label: string; items: TabMenuItem[] }

/** Decide the menu for a right-click on a tab. General "New Tab" + "Duplicate",
 * then (for a non-pinned tab) the folder actions, then Pin/Unpin and Close.
 * Id-taking commands carry the tab id so they hit the clicked tab, not the active
 * one. */
export function buildTabMenu(tab: TabMenuTarget, folders: TabMenuFolder[]): TabMenuItem[] {
  const items: TabMenuItem[] = [
    { type: 'command', command: 'new-tab', label: 'New Tab', enabled: true },
    { type: 'duplicate', label: 'Duplicate Tab' }
  ]

  // Folders never apply to a pinned tab (pinning takes a tab out of its folder).
  if (!tab.pinned) {
    const moveItems: TabMenuItem[] = folders
      // Don't offer the folder the tab is already in.
      .filter((f) => f.id !== tab.folderId)
      .map((f) => ({
        type: 'command',
        command: 'move-tab-to-folder',
        params: { tabId: tab.id, folderId: f.id },
        label: f.title.trim() || 'Untitled',
        enabled: true
      }))
    // Create a fresh folder (default name; renamed inline in the sidebar) with
    // this tab already inside it.
    moveItems.push({
      type: 'command',
      command: 'create-tab-folder',
      params: { title: 'New folder', tabId: tab.id },
      label: 'New Folder…',
      enabled: true
    })
    items.push(
      { type: 'separator' },
      { type: 'submenu', label: 'Move to Folder', items: moveItems }
    )
    if (tab.folderId !== null) {
      items.push({
        type: 'command',
        command: 'move-tab-to-folder',
        params: { tabId: tab.id, folderId: null },
        label: 'Remove from Folder',
        enabled: true
      })
    }
  }

  items.push(
    { type: 'separator' },
    tab.pinned
      ? {
          type: 'command',
          command: 'unpin-tab',
          params: { id: tab.id },
          label: 'Unpin Tab',
          enabled: true
        }
      : {
          type: 'command',
          command: 'pin-tab',
          params: { id: tab.id },
          label: 'Pin Tab',
          enabled: true
        },
    // Keep-awake toggle: mark the tab so it never sleeps (woken on restore, immune
    // to discard). The label reflects the tab's current state — there is no marker
    // on the tab itself, so this menu is the only place to see and flip it.
    {
      type: 'command',
      command: 'set-tab-awake',
      params: { id: tab.id, keepAwake: !tab.keepAwake },
      label: tab.keepAwake ? 'Stop Keeping Awake' : 'Keep Awake',
      enabled: true
    },
    { type: 'separator' },
    {
      type: 'command',
      command: 'copy-tab-id',
      params: { id: tab.id },
      label: 'Copy Tab ID',
      enabled: true
    },
    {
      type: 'command',
      command: 'close-tab',
      params: { id: tab.id },
      label: 'Close Tab',
      enabled: true
    }
  )

  return items
}
