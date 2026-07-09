// The native application menu. Profile switching lives here (a "Profiles"
// submenu) instead of in the toolbar, to keep the chrome compact. The menu is
// rebuilt whenever the set of profiles or the focused one changes.

import { Menu, type MenuItemConstructorOptions } from 'electron'
import type { BookmarkTree } from './bookmark-store'

export interface AppMenuHandlers {
  listProfiles: () => {
    profiles: Array<{ id: string; label: string; open: boolean }>
    focused: string | null
  }
  openProfile: (id: string) => void
  newProfile: () => void
  openSettings: () => void
  /** Navigate the focused window back / forward in its history. Wired to the
   * back / forward commands so the Cmd+Arrow accelerators stay pilotable. */
  goBack: () => void
  goForward: () => void
  /** Open a new tab (Cmd+T) / close the active tab (Cmd+W) in the focused window.
   * Wired to the new-tab / close-active-tab commands. Cmd+W closes a tab, never
   * the window — window closing moves to Cmd+Shift+W (see the File menu). */
  newTab: () => void
  closeTab: () => void
  /** Discard the active tab's page (Cmd+S): free its RAM, keep the tab, and move
   * to the next tab. Wired to the discard-active-tab command. */
  discardTab: () => void
  /** Step up / down the vertical tab strip (Cmd+Up / Cmd+Down). Wired to the
   * prev-tab / next-tab commands; steps through every tab, asleep or not. */
  prevTab: () => void
  nextTab: () => void
  /** Bookmark the focused window's active tab (Cmd+D). Wired to the add-bookmark
   * command with no url, which defaults to the active tab. */
  addBookmark: () => void
  /** The favorites tree, rendered as the Bookmarks submenu: folders become nested
   * submenus, urls become clickable items. */
  listBookmarks: () => BookmarkTree
  /** Open a url favorite by id (wired to the open-bookmark command). */
  openBookmark: (id: string) => void
}

/** A menu label for one bookmark, capped so a long url doesn't stretch the menu. */
function bookmarkLabel(text: string): string {
  const t = text.trim() || 'Untitled'
  return t.length > 64 ? t.slice(0, 63) + '…' : t
}

/** Render the favorites tree into menu items: folder → nested submenu (with an
 * "(empty)" placeholder so an empty folder is still visibly a folder), url →
 * a click that opens it. Recursive, mirroring the tree depth. */
function bookmarkMenuItems(
  nodes: BookmarkTree,
  openBookmark: (id: string) => void
): MenuItemConstructorOptions[] {
  return nodes.map((node) =>
    node.kind === 'folder'
      ? {
          label: bookmarkLabel(node.title),
          submenu: node.children.length
            ? bookmarkMenuItems(node.children, openBookmark)
            : [{ label: '(empty)', enabled: false }]
        }
      : {
          label: bookmarkLabel(node.title || node.url),
          click: () => openBookmark(node.id)
        }
  )
}

export function buildAppMenu(handlers: AppMenuHandlers): void {
  const { profiles, focused } = handlers.listProfiles()
  const isMac = process.platform === 'darwin'

  const profileItems: MenuItemConstructorOptions[] = profiles.map((profile) => ({
    // Every known profile is listed (open or not). The radio marks the focused
    // one; clicking a closed profile opens it, an open one just focuses it.
    label: profile.label,
    type: 'radio',
    checked: profile.id === focused,
    click: () => handlers.openProfile(profile.id)
  }))

  const settingsItem: MenuItemConstructorOptions = {
    label: 'Settings…',
    accelerator: 'CmdOrCtrl+,',
    click: () => handlers.openSettings()
  }

  // On mac, Settings conventionally lives in the app menu (Cmd+,). Build that
  // submenu by hand so we can inject it while keeping the standard items.
  const macAppMenu: MenuItemConstructorOptions = {
    role: 'appMenu',
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      settingsItem,
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' }
    ]
  }

  // A custom File menu: Cmd+W closes the active TAB (not the window), so window
  // closing moves to Cmd+Shift+W. On the last tab the window stays open on an
  // empty home (see closeTabIn in profiles.ts). New Tab is Cmd+T.
  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => handlers.newTab() },
      { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => handlers.closeTab() },
      // Cmd+S discards the active tab's page to reclaim RAM but keeps the tab
      // (asleep) and moves to the nearest already-loaded tab (never waking a
      // sleeping one) — not the browser's "Save Page As".
      { label: 'Discard Tab', accelerator: 'CmdOrCtrl+S', click: () => handlers.discardTab() },
      { type: 'separator' },
      // Move up / down the vertical tab strip; wraps around the ends. The
      // accelerator is shown for discoverability but NOT registered here
      // (registerAccelerator: false): the key is handled by a before-input-event
      // hook on every webContents (see wireTabShortcuts in profiles.ts) so it
      // beats a focused page that would otherwise swallow Cmd+Up/Down. The click
      // handler still fires when the item is chosen with the mouse.
      {
        label: 'Previous Tab',
        accelerator: 'CmdOrCtrl+Up',
        registerAccelerator: false,
        click: () => handlers.prevTab()
      },
      {
        label: 'Next Tab',
        accelerator: 'CmdOrCtrl+Down',
        registerAccelerator: false,
        click: () => handlers.nextTab()
      },
      { type: 'separator' },
      { role: 'close', label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W' }
    ]
  }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [macAppMenu] : []),
    fileMenu,
    { role: 'editMenu' },
    {
      // Back / forward. Cmd+Arrow accelerators work whatever holds focus (the
      // web content or the chrome), which a renderer keydown listener cannot do.
      label: 'History',
      submenu: [
        { label: 'Back', accelerator: 'CmdOrCtrl+Left', click: () => handlers.goBack() },
        { label: 'Forward', accelerator: 'CmdOrCtrl+Right', click: () => handlers.goForward() }
      ]
    },
    {
      label: 'Profiles',
      submenu: [
        ...(profileItems.length
          ? profileItems
          : [{ label: 'No profiles', enabled: false } as MenuItemConstructorOptions]),
        { type: 'separator' },
        { label: 'New Profile', click: () => handlers.newProfile() }
      ]
    },
    {
      // Favorites. Cmd+D bookmarks the active tab; the tree below (folders as
      // nested submenus, urls as items) is the favorites surface. The menu is
      // rebuilt on every bookmark change (see onBookmarksChange in index.ts).
      label: 'Bookmarks',
      submenu: [
        {
          label: 'Add to Favorites',
          accelerator: 'CmdOrCtrl+D',
          click: () => handlers.addBookmark()
        },
        { type: 'separator' },
        ...(() => {
          const tree = handlers.listBookmarks()
          return tree.length
            ? bookmarkMenuItems(tree, handlers.openBookmark)
            : [{ label: 'No favorites', enabled: false } as MenuItemConstructorOptions]
        })()
      ]
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
