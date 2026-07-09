import { ElectronAPI } from '@electron-toolkit/preload'

/** One tab as the chrome renders it (mirrors TabInfo in the command registry). */
export interface TabInfo {
  id: string
  title: string
  url: string
  favicon: string | null
}

/** The tab strip main pushes to a profile window's chrome. */
export interface TabsState {
  tabs: TabInfo[]
  activeId: string | null
  panelCollapsed: boolean
}

export interface MiraAPI {
  /** Run a command from the main-process registry (navigate, etc.). */
  command: (name: string, params?: unknown) => Promise<unknown>
  /** Subscribe to this window's profile being relabelled. Returns unsubscribe. */
  onProfileRenamed: (callback: (label: string) => void) => () => void
  /** Subscribe to the profile set changing (Settings window). Returns unsubscribe. */
  onProfilesChanged: (callback: () => void) => () => void
  /** Subscribe to this window's tab strip changing. Returns unsubscribe. */
  onTabsChanged: (callback: (state: TabsState) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: unknown
    mira: MiraAPI
  }
}
