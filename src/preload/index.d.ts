import { ElectronAPI } from '@electron-toolkit/preload'

/** One tab as the chrome renders it (mirrors TabInfo in the command registry). */
export interface TabInfo {
  id: string
  title: string
  url: string
  favicon: string | null
  /** Lazy-load state: false for an asleep tab (no web view yet). */
  loaded: boolean
  /** 'settings' for the internal Settings tab (chrome-rendered), else 'web'. */
  kind: 'web' | 'settings'
  /** Pinned: rendered as a compact square in the grid at the head of the strip. */
  pinned: boolean
  /** Id of the tab folder this tab is in, or null when loose (in no folder). */
  folderId: string | null
  /** Whether the tab is currently playing sound (live runtime flag, not persisted).
   * Drives the sidebar's speaker icon and the toolbar audio button. */
  audible: boolean
}

/** A tab folder (metadata): the sidebar groups tabs by folderId; this carries the
 * label, collapse state, and order. */
export interface TabFolder {
  id: string
  title: string
  collapsed: boolean
  /** Accent color (a CSS color string), or absent for the default look. */
  color?: string
}

/** The tab strip main pushes to a profile window's chrome. */
export interface TabsState {
  tabs: TabInfo[]
  activeId: string | null
  panelCollapsed: boolean
  /** The window's tab folders (metadata, in sidebar order). */
  folders: TabFolder[]
  /** Zen (focus) mode: true while the toolbar, status bar, and both side panels
   * are hidden. Rides this channel because it is a chrome layout bit like
   * panelCollapsed. */
  chromeHidden: boolean
}

/** A favorites tree node (mirrors BookmarkNode in the registry). The full tree
 * is rendered in the native Bookmarks menu; the chrome uses it only to drive the
 * address-bar star. */
export interface BookmarkNode {
  id: string
  kind: 'url' | 'folder'
  title: string
  /** Present on url nodes. */
  url?: string
  /** Present on folder nodes. */
  children?: BookmarkNode[]
}

/** The (global) favorites tree main pushes to every window's chrome. */
export interface BookmarksState {
  tree: BookmarkNode[]
}

/** One turn of the pane conversation (mirrors ChatMessage in the registry). */
export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
}

/** The right-side AI pane state main pushes (mirrors SkillPaneState in the
 * registry): a chat thread — `messages` is the conversation, `status` tracks the
 * in-flight turn (loading, then idle, or error). */
export interface SkillPaneState {
  open: boolean
  title: string
  status: 'idle' | 'loading' | 'error'
  messages: ChatMessage[]
  error?: string
}

export interface MiraAPI {
  /** Run a command from the main-process registry (navigate, etc.). */
  command: (name: string, params?: unknown) => Promise<unknown>
  /** Subscribe to this window's profile being relabelled. Returns unsubscribe. */
  onProfileRenamed: (callback: (label: string) => void) => () => void
  /** Subscribe to this window's profile theme changing. The callback receives the
   * resolved theme object ({ background, text, accent?, wallpaper?, … }), or null
   * when cleared. Returns unsubscribe. */
  onProfileThemeChanged: (callback: (theme: unknown) => void) => () => void
  /** Subscribe to the profile set changing (Settings window). Returns unsubscribe. */
  onProfilesChanged: (callback: () => void) => () => void
  /** Subscribe to the web-permission grant log changing (Settings). Returns unsubscribe. */
  onPermissionsChanged: (callback: () => void) => () => void
  /** Subscribe to the file-downloads list changing (a download starts, progresses,
   * or finishes) so the status bar can re-poll get-download-stats. Returns unsubscribe. */
  onDownloadsChanged: (callback: () => void) => () => void
  /** Subscribe to this window's tab strip changing. Returns unsubscribe. */
  onTabsChanged: (callback: (state: TabsState) => void) => () => void
  /** Subscribe to the "focus the address bar" push (new tab opened). Returns unsubscribe. */
  onFocusAddressBar: (callback: () => void) => () => void
  /** Subscribe to the "show the find bar" push (Cmd+F / find-open). Returns
   * unsubscribe. */
  onFindOpen: (callback: () => void) => () => void
  /** Subscribe to the current search's match tally ("n/m" in the find bar).
   * Returns unsubscribe. */
  onFindResult: (
    callback: (result: { matches: number; activeMatchOrdinal: number }) => void
  ) => () => void
  /** Subscribe to the hovered-link URL in the active page (empty string on leave).
   * Returns unsubscribe. */
  onHoverUrl: (callback: (url: string) => void) => () => void
  /** Subscribe to the (global) favorites list changing. Returns unsubscribe. */
  onBookmarksChanged: (callback: (state: BookmarksState) => void) => () => void
  /** Subscribe to the command palette being toggled (main owns the state). The
   * payload's `mode` is 'launcher' (Cmd+K) or 'address' (typed in the URL bar),
   * and `query` seeds the input. Returns unsubscribe. */
  onTogglePalette: (
    callback: (state: { open: boolean; mode: 'launcher' | 'address'; query: string }) => void
  ) => () => void
  /** Subscribe to the right-side skill pane's state (a skill's AI result). Returns
   * unsubscribe. */
  onSkillPane: (callback: (state: SkillPaneState) => void) => () => void
  /** Subscribe to the fullscreen media gallery overlay being toggled (main owns
   * the state and hides the web view while open). Returns unsubscribe. */
  onMediaGallery: (callback: (state: { open: boolean }) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: unknown
    mira: MiraAPI
  }
}
