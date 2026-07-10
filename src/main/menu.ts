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
  /** Toggle the Cmd+K command palette in the focused window. A menu accelerator
   * (not a renderer keydown) so it fires whatever holds focus — chrome or page. */
  togglePalette: () => void
  /** Navigate the focused window back / forward in its history. Wired to the
   * back / forward commands so the Cmd+Arrow accelerators stay pilotable. */
  goBack: () => void
  goForward: () => void
  /** Reload the focused window's active tab (Cmd+R). Wired to the reload command,
   * so the accelerator hits the same bus as the toolbar button and the socket. */
  reload: () => void
  /** Open a new tab (Cmd+T) / close the active tab (Cmd+W) in the focused window.
   * Wired to the new-tab / close-active-tab commands. Cmd+W closes a tab, never
   * the window — window closing moves to Cmd+Shift+W (see the File menu). */
  newTab: () => void
  closeTab: () => void
  /** Reopen the most recently closed tab (Cmd+Shift+T) in the focused window.
   * Wired to the reopen-closed-tab command; a no-op when nothing was closed. */
  reopenTab: () => void
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
  /** Zoom the focused window's active tab in / out / back to 100% (Cmd+ / Cmd- /
   * Cmd0). Wired to the zoom-in / zoom-out / zoom-reset commands so the page
   * zooms — not Mira's own chrome, which the default zoom roles would hit. */
  zoomIn: () => void
  zoomOut: () => void
  zoomReset: () => void
  /** Toggle the DevTools inspector on the focused window's active tab (⌥⌘I).
   * Wired to the toggle-devtools command, which targets the tab's own webContents
   * and opens detached — NOT the default role:'toggleDevTools', which hits the
   * focused webContents (Mira's chrome when the address bar has focus) and gets
   * stuck open once focus leaves the page. */
  toggleDevTools: () => void
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
      {
        label: 'Command Palette…',
        accelerator: 'CmdOrCtrl+K',
        click: () => handlers.togglePalette()
      },
      { type: 'separator' },
      { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => handlers.newTab() },
      { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => handlers.closeTab() },
      {
        label: 'Reopen Closed Tab',
        accelerator: 'CmdOrCtrl+Shift+T',
        click: () => handlers.reopenTab()
      },
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
        { label: 'Forward', accelerator: 'CmdOrCtrl+Right', click: () => handlers.goForward() },
        { type: 'separator' },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => handlers.reload() }
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
    {
      // A hand-built View menu, deliberately WITHOUT the default role:'reload' /
      // role:'forceReload'. Those reload the *focused* webContents — which is
      // Mira's own chrome when the address bar / sidebar has focus — and their
      // Cmd+R accelerator would shadow our History → Reload (which reloads the
      // active TAB via the registry). Keep the rest of the standard View items.
      label: 'View',
      submenu: [
        {
          label: 'Toggle Developer Tools',
          accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          click: () => handlers.toggleDevTools()
        },
        { type: 'separator' },
        // Zoom the active TAB's page via the registry (like Reload above), NOT
        // the default zoom roles which target the focused webContents — Mira's
        // chrome when the address bar has focus. Cmd+= is the physical key for
        // "zoom in" (no Shift); a hidden twin binds Cmd+Plus so both fire it.
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => handlers.zoomReset() },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => handlers.zoomIn() },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', visible: false, click: () => handlers.zoomIn() },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => handlers.zoomOut() },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
