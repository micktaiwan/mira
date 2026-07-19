// The command registry: the single source of truth for every Mira action.
// The UI (via IPC), an external unix socket, and an MCP server all reach these
// same commands. See the "tout pilotable" principle in CLAUDE.md.
//
// This is the composition root and public barrel. Every consumer imports the
// registry and its types from './commands' (which resolves here). The actual
// commands live one file per domain (navigation / profiles / settings); this
// file only merges their maps into one registry.
//
// To add a command: drop it in the matching domain file. To add a whole new
// domain: create its file, then add ONE import + ONE spread below. That single
// line is the only shared edit — everything else is domain-local, so parallel
// sessions rarely collide.

import { buildRegistry, type CommandMap, type CommandRegistryOf } from './registry'
import type { CommandContext } from './context'
import { appCommands } from './app'
import { audioCommands } from './audio'
import { bookmarksCommands } from './bookmarks'
import { cookieCommands } from './cookies'
import { devtoolsCommands } from './devtools'
import { downloadsCommands } from './downloads'
import { extensionsCommands } from './extensions'
import { findCommands } from './find'
import { folderMenuCommands } from './folder-menu'
import { forgetCommands } from './forget'
import { historyCommands } from './history'
import { inputCommands } from './input'
import { magnifierCommands } from './magnifier'
import { mediaCommands } from './media'
import { navigationCommands } from './navigation'
import { openCommands } from './open'
import { paletteCommands } from './palette'
import { paneCommands } from './pane'
import { permissionCommands } from './permissions'
import { profileCommands } from './profiles'
import { settingsCommands } from './settings'
import { skillsCommands } from './skills'
import { spacesCommands } from './spaces'
import { statusCommands } from './status'
import { tabFoldersCommands } from './tab-folders'
import { tabDetachCommands } from './tab-detach'
import { tabMemoryCommands } from './tab-memory'
import { tabMenuCommands } from './tab-menu'
import { tabsCommands } from './tabs'
import { themeCommands } from './themes'
import { toastCommands } from './toast'
import { tooltipCommands } from './tooltip'
import { vaultCommands } from './vault'
import { zenCommands } from './zen'

// Public types, re-exported so consumers keep importing from './commands'.
export type { CommandContext } from './context'
export type { NavigableContents, ProfileInfo, CommandResult, CommandHandler } from './registry'
export type { AppContext } from './app'
export type { AudioContext } from './audio'
export type { BookmarkContext } from './bookmarks'
export type { BookmarkNode, BookmarkUrl, BookmarkFolder, BookmarkTree } from '../bookmark-store'
export type { CookieContext, CookieSink, ImportCookiesParams } from './cookies'
export type { DevtoolsContext } from './devtools'
export type { DownloadsContext, DownloadRecord, DownloadState, DownloadStats } from './downloads'
export type {
  ExtensionsContext,
  ExtensionInfo,
  ServiceWorkerLogEntry,
  ServiceWorkerLogLevel,
  ServiceWorkerConsoleQuery
} from './extensions'
export {
  toExtensionInfo,
  selectServiceWorkerLogs,
  serviceWorkerLogLevel,
  extensionIdFromUrl,
  pickServiceWorkerExtensionId,
  extensionPopoutBounds,
  SW_LOG_LEVELS
} from './extensions'
export type { PopoutBounds } from './extensions'
export type { FindContext, FindStopAction } from './find'
export type { FolderMenuContext } from './folder-menu'
export type { HistoryContext } from './history'
export type { HistoryEntry } from '../history-store'
export type { InputContext, PressKeyParams } from './input'
export type { MagnifierContext } from './magnifier'
export type { MediaContext, MediaItem, MediaKind, MediaSource } from './media'
export type { NavContext } from './navigation'
export type { OpenContext } from './open'
export type { PaletteContext, PaletteMode } from './palette'
export type { PaletteEntry, PaletteGroup, PaletteState } from '../palette'
export type { PaneContext, SkillPaneState } from './pane'
export { closedSkillPane } from './pane'
export { formatMemory, formatTabs } from './status'
export type { PermissionContext } from './permissions'
export type { PermissionGrant } from '../permission-store'
export type { ProfileContext } from './profiles'
export type { SettingsContext } from './settings'
export type { SkillsContext } from './skills'
export type { Skill, SkillSource, SkillSink, SkillMatch } from '../skills'
export type { SpacesContext, SpacesState } from './spaces'
export type { DisplaySpaces, SpaceEntry, SpaceLocation } from '../spaces'
export type { StatusContext, MemoryUsage, TabCounts } from './status'
export type { TabFoldersContext } from './tab-folders'
export type { TabFolder, TabFolders } from '../tab-folder-store'
export type { TabMemoryContext, TabMemoryEntry, TabMemoryReport } from './tab-memory'
export { formatBytes, rankTabMemory, totalDistinctMemory } from './tab-memory'
export type { TabDetachContext, WindowInfo } from './tab-detach'
export type { TabMenuContext } from './tab-menu'
export type { TabsContext, TabInfo, TabKind } from './tabs'
export type { ThemeContext } from './themes'
export type { Theme, ThemeInput } from '../theme-store'
export type { ToastContext } from './toast'
export type { TooltipContext } from './tooltip'
export type { VaultContext } from './vault'
export type { ZenContext, ZenState, PanelSnapshot } from './zen'
export { nextZen } from './zen'

export type CommandRegistry = CommandRegistryOf<CommandContext>

export function createCommandRegistry(): CommandRegistry {
  const commands: CommandMap<CommandContext> = {
    ...appCommands,
    ...audioCommands,
    ...bookmarksCommands,
    ...cookieCommands,
    ...devtoolsCommands,
    ...downloadsCommands,
    ...extensionsCommands,
    ...findCommands,
    ...folderMenuCommands,
    ...forgetCommands,
    ...historyCommands,
    ...inputCommands,
    ...magnifierCommands,
    ...mediaCommands,
    ...navigationCommands,
    ...openCommands,
    ...paletteCommands,
    ...paneCommands,
    ...permissionCommands,
    ...profileCommands,
    ...settingsCommands,
    ...skillsCommands,
    ...spacesCommands,
    ...statusCommands,
    ...tabFoldersCommands,
    ...tabMemoryCommands,
    ...tabDetachCommands,
    ...tabMenuCommands,
    ...tabsCommands,
    ...themeCommands,
    ...toastCommands,
    ...tooltipCommands,
    ...vaultCommands,
    ...zenCommands
  }
  return buildRegistry(commands)
}
