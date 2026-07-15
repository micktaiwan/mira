// The right-click menu shown on a tab folder's header in the sidebar. Like
// tab-menu.ts, the popup itself is thin and NATIVE (in profiles.ts) — a CSS
// popover over the sidebar could be clipped by the WebContentsView (CLAUDE.md
// "les deux pièges" #3), and a native menu always composites above it. This pure,
// testable function decides WHICH items to show for a given folder.
//
// Actions are emitted as `command` items so they route through the same registry
// bus as everything else ("tout pilotable"): collapse/expand, pick an accent
// color (or clear it), and remove the folder. Rename is not here — it is the
// sidebar's inline double-click field (a native menu can't host a text input).

/** The folder a right-click landed on: enough to label collapse vs expand and to
 * mark the currently selected color. */
export interface FolderMenuTarget {
  id: string
  collapsed: boolean
  /** The folder's current accent color, or null when none is set. */
  color: string | null
}

/** One preset accent color, offered in the "Color" submenu. */
export interface FolderMenuColor {
  /** Human label shown in the menu (e.g. "Blue"). */
  name: string
  /** The CSS color value stored on the folder (e.g. "#4d7cfe"). */
  value: string
}

/** The preset accent colors offered for a folder. Kept in sync with the profile
 * palette (PROFILE_COLORS in profile-store.ts / Settings.tsx) so the two color
 * pickers feel like one system. Any hex is still settable via the bus. */
export const FOLDER_COLORS: readonly FolderMenuColor[] = [
  { name: 'Blue', value: '#4d7cfe' },
  { name: 'Purple', value: '#8b5cf6' },
  { name: 'Pink', value: '#ec4899' },
  { name: 'Red', value: '#ef4444' },
  { name: 'Orange', value: '#f97316' },
  { name: 'Yellow', value: '#eab308' },
  { name: 'Green', value: '#22c55e' },
  { name: 'Teal', value: '#14b8a6' }
]

/** One entry of the resolved folder menu. `command` routes through the registry;
 * `checked` marks the active color; `submenu` nests items; `separator` divides. */
export type FolderMenuItem =
  | { type: 'separator' }
  | {
      type: 'command'
      command: string
      params?: Record<string, unknown>
      label: string
      enabled: boolean
      /** Shown with a checkmark (the currently selected color). */
      checked?: boolean
    }
  | { type: 'submenu'; label: string; items: FolderMenuItem[] }

/** Decide the menu for a right-click on a folder header: collapse/expand toggle,
 * a "Color" submenu (each preset, then "No Color" to clear — the active one
 * checked), then Remove. Id-taking commands carry the folder id. */
export function buildFolderMenu(
  folder: FolderMenuTarget,
  colors: readonly FolderMenuColor[] = FOLDER_COLORS
): FolderMenuItem[] {
  const colorItems: FolderMenuItem[] = colors.map((c) => ({
    type: 'command',
    command: 'set-tab-folder-color',
    params: { id: folder.id, color: c.value },
    label: c.name,
    enabled: true,
    checked: folder.color !== null && folder.color.toLowerCase() === c.value.toLowerCase()
  }))
  colorItems.push(
    { type: 'separator' },
    {
      type: 'command',
      command: 'set-tab-folder-color',
      params: { id: folder.id, color: null },
      label: 'No Color',
      enabled: true,
      checked: folder.color === null
    }
  )

  return [
    {
      type: 'command',
      command: 'toggle-tab-folder',
      params: { id: folder.id },
      label: folder.collapsed ? 'Expand Folder' : 'Collapse Folder',
      enabled: true
    },
    { type: 'separator' },
    { type: 'submenu', label: 'Color', items: colorItems },
    { type: 'separator' },
    {
      type: 'command',
      command: 'remove-tab-folder',
      params: { id: folder.id },
      label: 'Remove Folder',
      enabled: true
    }
  ]
}
