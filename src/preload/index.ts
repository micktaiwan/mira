import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

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
  // Main pings the Settings window whenever the profile set changes (elsewhere),
  // so it can refetch the list. Returns an unsubscribe function.
  onProfilesChanged: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('mira:profiles-changed', listener)
    return () => ipcRenderer.removeListener('mira:profiles-changed', listener)
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
  // Main pushes the (global) favorites list on every add / remove — the sidebar
  // and address-bar star render it, holding no bookmark state. Returns unsubscribe.
  onBookmarksChanged: (callback: (state: unknown) => void): (() => void) => {
    const listener = (_event: unknown, state: unknown): void => callback(state)
    ipcRenderer.on('mira:bookmarks-changed', listener)
    return () => ipcRenderer.removeListener('mira:bookmarks-changed', listener)
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
