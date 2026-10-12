// The keyboard shortcuts of Mira's own actions, declared once. The native menu
// (menu.ts) binds them and the command palette (palette.ts) displays them; both
// read this table, so the palette can no longer show a key the menu does not bind
// (it once showed ⌘S for Discard Tab while the menu bound ⌥⌘S). Pure, no Electron.

/** Electron accelerator strings, keyed by the action they trigger. */
export const SHORTCUTS = {
  settings: 'CmdOrCtrl+,',
  commandPalette: 'CmdOrCtrl+K',
  commandPaletteShift: 'CmdOrCtrl+Shift+K',
  openLocation: 'CmdOrCtrl+L',
  newTab: 'CmdOrCtrl+T',
  duplicateTab: 'CmdOrCtrl+Shift+D',
  closeTab: 'CmdOrCtrl+W',
  closeTabToRecent: 'CmdOrCtrl+Alt+Shift+W',
  forgetSite: 'CmdOrCtrl+Alt+W',
  clearSiteData: 'CmdOrCtrl+Alt+Backspace',
  reopenTab: 'CmdOrCtrl+Shift+T',
  discardTab: 'CmdOrCtrl+Alt+S',
  wakeAllTabs: 'CmdOrCtrl+Shift+A',
  prevTab: 'CmdOrCtrl+Up',
  nextTab: 'CmdOrCtrl+Down',
  recentTabBack: 'CmdOrCtrl+Alt+Left',
  recentTabForward: 'CmdOrCtrl+Alt+Right',
  moveTabToTop: 'CmdOrCtrl+Alt+Up',
  revealTab: 'CmdOrCtrl+Shift+E',
  closeWindow: 'CmdOrCtrl+Shift+W',
  find: 'CmdOrCtrl+F',
  findNext: 'CmdOrCtrl+G',
  findPrevious: 'CmdOrCtrl+Shift+G',
  fillLogin: 'CmdOrCtrl+Shift+L',
  back: 'CmdOrCtrl+Left',
  forward: 'CmdOrCtrl+Right',
  rootDomain: 'CmdOrCtrl+Shift+Up',
  reload: 'CmdOrCtrl+R',
  hardReload: 'CmdOrCtrl+Shift+R',
  addBookmark: 'CmdOrCtrl+D',
  toggleTabsPanel: 'CmdOrCtrl+B',
  toggleSkillPane: 'CmdOrCtrl+J',
  toggleZen: 'CmdOrCtrl+Shift+H',
  toggleDevTools: 'Alt+Cmd+I',
  zoomReset: 'CmdOrCtrl+0',
  zoomIn: 'CmdOrCtrl+=',
  zoomInPlus: 'CmdOrCtrl+Plus',
  zoomOut: 'CmdOrCtrl+-',
  toggleFullScreen: 'Control+Command+F'
} as const

export type ShortcutName = keyof typeof SHORTCUTS

const MODIFIER_SYMBOLS: Record<string, string> = {
  control: '⌃',
  ctrl: '⌃',
  alt: '⌥',
  option: '⌥',
  shift: '⇧',
  cmd: '⌘',
  command: '⌘',
  cmdorctrl: '⌘',
  commandorcontrol: '⌘'
}

/** macOS menus list modifiers in this order, whatever order the string uses. */
const MODIFIER_ORDER = ['⌃', '⌥', '⇧', '⌘']

const KEY_SYMBOLS: Record<string, string> = {
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  backspace: '⌫',
  delete: '⌦',
  return: '↩',
  enter: '↩',
  escape: '⎋',
  esc: '⎋',
  tab: '⇥',
  space: 'Space',
  plus: '+'
}

/** Render an Electron accelerator the way a macOS menu shows it:
 * 'CmdOrCtrl+Alt+Shift+W' → '⌥⇧⌘W'. Unknown modifiers are kept as written. */
export function formatAccelerator(accelerator: string): string {
  const parts = accelerator.split('+')
  // 'CmdOrCtrl+Plus' is fine, but a literal '+' key would split into empties.
  const key = parts.pop() || '+'
  const mods = parts.map((m) => MODIFIER_SYMBOLS[m.toLowerCase()] ?? m)
  mods.sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b))
  const shownKey = KEY_SYMBOLS[key.toLowerCase()] ?? key.toUpperCase()
  return mods.join('') + shownKey
}

/** The palette label of a named shortcut. */
export function shortcutLabel(name: ShortcutName): string {
  return formatAccelerator(SHORTCUTS[name])
}
