// The native application menu. Profile switching lives here (a "Profiles"
// submenu) instead of in the toolbar, to keep the chrome compact. The menu is
// rebuilt whenever the set of profiles or the focused one changes.

import { Menu, type MenuItemConstructorOptions } from 'electron'

export interface AppMenuHandlers {
  listProfiles: () => { profiles: string[]; focused: string | null }
  openProfile: (name: string) => void
  newProfile: () => void
}

export function buildAppMenu(handlers: AppMenuHandlers): void {
  const { profiles, focused } = handlers.listProfiles()
  const isMac = process.platform === 'darwin'

  const profileItems: MenuItemConstructorOptions[] = profiles.map((name) => ({
    label: name,
    type: 'radio',
    checked: name === focused,
    click: () => handlers.openProfile(name)
  }))

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
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
