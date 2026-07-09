// The native application menu. Profile switching lives here (a "Profiles"
// submenu) instead of in the toolbar, to keep the chrome compact. The menu is
// rebuilt whenever the set of profiles or the focused one changes.

import { Menu, type MenuItemConstructorOptions } from 'electron'

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

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [macAppMenu] : []),
    { role: 'fileMenu' },
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
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
