import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { injectBrowserAction } from 'electron-chrome-extensions/browser-action'

// Make the <browser-action-list> custom element (extension action buttons +
// popups) available to the chrome. This preload only ever loads in Mira's own
// chrome windows — never in tab WebContentsViews — so no url gating is needed.
// The lib handles context isolation itself (contextBridge + main-world script).
injectBrowserAction()

// Custom APIs for renderer
const api = {}

// Mira: run a command from the registry. This is the renderer's only way to
// act on the browser — it never mutates state directly (see CLAUDE.md).
const mira = {
  command: (name: string, params?: unknown): Promise<unknown> =>
    ipcRenderer.invoke('command', name, params),
  // Main pushes the new label when this window's profile is renamed, so the
  // badge refreshes without a reload. Returns an unsubscribe function.
  onProfileRenamed: (callback: (label: string) => void): (() => void) => {
    const listener = (_event: unknown, label: string): void => callback(label)
    ipcRenderer.on('mira:profile-renamed', listener)
    return () => ipcRenderer.removeListener('mira:profile-renamed', listener)
  },
  // Main pushes the new theme color (a hex, or null when cleared) when this
  // window's profile color changes, so the chrome re-tints without a reload.
  // Returns an unsubscribe function.
  onProfileThemeChanged: (callback: (color: string | null) => void): (() => void) => {
    const listener = (_event: unknown, color: string | null): void => callback(color)
    ipcRenderer.on('mira:profile-theme', listener)
    return () => ipcRenderer.removeListener('mira:profile-theme', listener)
  },
  // Main pings the Settings window whenever the profile set changes (elsewhere),
  // so it can refetch the list. Returns an unsubscribe function.
  onProfilesChanged: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('mira:profiles-changed', listener)
    return () => ipcRenderer.removeListener('mira:profiles-changed', listener)
  },
  // Main pings open windows whenever a web permission is granted (natively, when a
  // page requests one), so an open Settings tab refetches the grant list. Returns
  // an unsubscribe function.
  onPermissionsChanged: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('mira:permissions-changed', listener)
    return () => ipcRenderer.removeListener('mira:permissions-changed', listener)
  },
  // Main pushes this window's tab strip (tabs, active id, panel state) on every
  // change — the chrome holds no tab state, it just renders what main sends.
  // Returns an unsubscribe function.
  onTabsChanged: (callback: (state: unknown) => void): (() => void) => {
    const listener = (_event: unknown, state: unknown): void => callback(state)
    ipcRenderer.on('mira:tabs-changed', listener)
    return () => ipcRenderer.removeListener('mira:tabs-changed', listener)
  },
  // Main asks the chrome to focus the address bar when a new tab opens (click or
  // Cmd+T), so a url can be typed without clicking first. Returns unsubscribe.
  onFocusAddressBar: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('mira:focus-address-bar', listener)
    return () => ipcRenderer.removeListener('mira:focus-address-bar', listener)
  },
  // Main asks the chrome to show + focus the find-in-page bar (Cmd+F, or the
  // find-open command from the palette / socket). Returns an unsubscribe function.
  onFindOpen: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('mira:find-open', listener)
    return () => ipcRenderer.removeListener('mira:find-open', listener)
  },
  // Main pushes the current search's match tally (from Chromium's found-in-page
  // event) so the find bar can show "n/m". Returns an unsubscribe function.
  onFindResult: (
    callback: (result: { matches: number; activeMatchOrdinal: number }) => void
  ): (() => void) => {
    const listener = (
      _event: unknown,
      result: { matches: number; activeMatchOrdinal: number }
    ): void => callback(result)
    ipcRenderer.on('mira:find-result', listener)
    return () => ipcRenderer.removeListener('mira:find-result', listener)
  },
  // Main pushes the URL of the link the cursor is hovering in the active page
  // (empty string when the cursor leaves the link), so the status bar can show it
  // browser-style. Returns an unsubscribe function.
  onHoverUrl: (callback: (url: string) => void): (() => void) => {
    const listener = (_event: unknown, url: string): void => callback(url)
    ipcRenderer.on('mira:hover-url', listener)
    return () => ipcRenderer.removeListener('mira:hover-url', listener)
  },
  // Main pushes the (global) favorites list on every add / remove — the sidebar
  // and address-bar star render it, holding no bookmark state. Returns unsubscribe.
  onBookmarksChanged: (callback: (state: unknown) => void): (() => void) => {
    const listener = (_event: unknown, state: unknown): void => callback(state)
    ipcRenderer.on('mira:bookmarks-changed', listener)
    return () => ipcRenderer.removeListener('mira:bookmarks-changed', listener)
  },
  // Main drives the command palette's visibility (it owns the state so the
  // hidden/shown web view stays in sync). The payload carries the mode
  // ('launcher' for Cmd+K, 'address' for the URL bar) and the seeded query, so
  // the chrome renders the right variant. Returns an unsubscribe function.
  onTogglePalette: (
    callback: (state: { open: boolean; mode: 'launcher' | 'address'; query: string }) => void
  ): (() => void) => {
    const listener = (
      _event: unknown,
      state: { open: boolean; mode: 'launcher' | 'address'; query: string }
    ): void => callback(state)
    ipcRenderer.on('mira:toggle-palette', listener)
    return () => ipcRenderer.removeListener('mira:toggle-palette', listener)
  },
  // Main pushes the right-side skill pane's state (a skill's AI result): loading
  // while the engine works, then the summary or an error. Main owns it (it shrinks
  // the web view to make room), the chrome renders SkillPane to match. Returns
  // an unsubscribe function.
  onSkillPane: (callback: (state: unknown) => void): (() => void) => {
    const listener = (_event: unknown, state: unknown): void => callback(state)
    ipcRenderer.on('mira:skill-pane', listener)
    return () => ipcRenderer.removeListener('mira:skill-pane', listener)
  },
  // Main drives the fullscreen media gallery's visibility (it owns the state so
  // the hidden/shown web view stays in sync). Returns an unsubscribe function.
  onMediaGallery: (callback: (state: { open: boolean }) => void): (() => void) => {
    const listener = (_event: unknown, state: { open: boolean }): void => callback(state)
    ipcRenderer.on('mira:media-gallery', listener)
    return () => ipcRenderer.removeListener('mira:media-gallery', listener)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
    contextBridge.exposeInMainWorld('mira', mira)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
  // @ts-ignore (define in dts)
  window.mira = mira
}
