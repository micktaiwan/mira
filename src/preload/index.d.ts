import { ElectronAPI } from '@electron-toolkit/preload'

export interface MiraAPI {
  /** Run a command from the main-process registry (navigate, etc.). */
  command: (name: string, params?: unknown) => Promise<unknown>
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: unknown
    mira: MiraAPI
  }
}
