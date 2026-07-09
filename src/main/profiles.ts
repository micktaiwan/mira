// Profiles = separate browser windows, Chrome style. Each profile is its own
// window with its own persistent session partition (its own cookie jar), so you
// can be logged into the same site as different identities. Opening a profile
// that is already open just focuses its window (one window per profile).
//
// This is the Electron-backed part: it owns window creation, layout and the
// window<->profile mapping. It is thin and native (not unit-tested); the
// testable logic lives in the command registry, which reaches this only through
// the CommandContext interface built by contextForChrome / contextForFocused.

import { BrowserWindow, WebContentsView, shell, type WebContents } from 'electron'
import type { CommandContext } from './commands'

export const DEFAULT_PROFILE = 'default'

/** The default profile uses Electron's default session (keeps the existing
 * cookies); named profiles get an isolated persistent partition. */
function partitionFor(name: string): string | undefined {
  return name === DEFAULT_PROFILE ? undefined : `persist:mira-${name}`
}

interface ProfileWindow {
  window: BrowserWindow
  view: WebContentsView
  profile: string
}

export interface ProfileManagerDeps {
  toolbarHeight: number
  homeUrl: string
  preloadPath: string
  icon?: string
  /** Load the chrome (React) into a freshly created window for `profile`. Kept
   * as a callback so the electron-vite dev/prod URL logic stays in index.ts. */
  loadRenderer: (window: BrowserWindow, profile: string) => void
  /** Called when the set of profiles or the focused one changes, so the app
   * menu can be rebuilt. */
  onChange?: () => void
}

export class ProfileManager {
  private readonly byProfile = new Map<string, ProfileWindow>()

  constructor(private readonly deps: ProfileManagerDeps) {}

  /** Open a window for `name`, or focus it if one already exists. */
  openProfile(name: string): { profile: string; created: boolean } {
    const existing = this.byProfile.get(name)
    if (existing && !existing.window.isDestroyed()) {
      if (existing.window.isMinimized()) existing.window.restore()
      existing.window.focus()
      this.deps.onChange?.()
      return { profile: name, created: false }
    }
    this.create(name)
    this.deps.onChange?.()
    return { profile: name, created: true }
  }

  private create(name: string): ProfileWindow {
    const window = new BrowserWindow({
      width: 1000,
      height: 720,
      show: false,
      autoHideMenuBar: true,
      ...(this.deps.icon ? { icon: this.deps.icon } : {}),
      webPreferences: {
        preload: this.deps.preloadPath,
        sandbox: false
      }
    })

    const partition = partitionFor(name)
    const view = new WebContentsView({
      webPreferences: partition ? { partition } : {}
    })
    window.contentView.addChildView(view)

    const layout = (): void => {
      const { width, height } = window.getContentBounds()
      // Sit below the address bar. Reposition by hand on every resize — the view
      // is a native layer, not a DOM element (see CLAUDE.md, "les deux pièges").
      view.setBounds({
        x: 0,
        y: this.deps.toolbarHeight,
        width,
        height: Math.max(0, height - this.deps.toolbarHeight)
      })
    }
    layout()
    window.on('resize', layout)

    view.webContents.loadURL(this.deps.homeUrl)
    view.webContents.setWindowOpenHandler((details) => {
      shell.openExternal(details.url)
      return { action: 'deny' }
    })

    window.on('ready-to-show', () => window.show())
    // Track focus so the menu's active-profile checkmark stays in sync.
    window.on('focus', () => this.deps.onChange?.())
    window.on('closed', () => {
      this.byProfile.delete(name)
      this.deps.onChange?.()
    })

    this.deps.loadRenderer(window, name)

    const profileWindow: ProfileWindow = { window, view, profile: name }
    this.byProfile.set(name, profileWindow)
    return profileWindow
  }

  listProfiles(): { profiles: string[]; focused: string | null } {
    return { profiles: [...this.byProfile.keys()], focused: this.focusedProfile() }
  }

  private focusedProfile(): string | null {
    return this.findByWindow(BrowserWindow.getFocusedWindow())?.profile ?? null
  }

  private findByWindow(window: BrowserWindow | null): ProfileWindow | null {
    if (!window) return null
    for (const pw of this.byProfile.values()) {
      if (pw.window === window) return pw
    }
    return null
  }

  /** Context bound to the window that owns `sender` (the chrome that sent IPC). */
  contextForChrome(sender: WebContents): CommandContext {
    return this.makeContext(this.findByWindow(BrowserWindow.fromWebContents(sender)))
  }

  /** Context bound to the focused window (external socket/MCP). Falls back to
   * any open window so a request still lands somewhere sensible. */
  contextForFocused(): CommandContext {
    const target =
      this.findByWindow(BrowserWindow.getFocusedWindow()) ??
      this.byProfile.values().next().value ??
      null
    return this.makeContext(target)
  }

  private makeContext(target: ProfileWindow | null): CommandContext {
    return {
      getTargetWebContents: () => {
        if (!target || target.window.isDestroyed()) {
          throw new Error('no target window')
        }
        return target.view.webContents
      },
      getTargetProfile: () => target?.profile ?? null,
      openProfile: (name) => this.openProfile(name),
      listProfiles: () => this.listProfiles()
    }
  }
}
