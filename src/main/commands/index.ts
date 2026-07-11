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
import { bookmarksCommands } from './bookmarks'
import { cookieCommands } from './cookies'
import { devtoolsCommands } from './devtools'
import { extensionsCommands } from './extensions'
import { findCommands } from './find'
import { historyCommands } from './history'
import { navigationCommands } from './navigation'
import { paletteCommands } from './palette'
import { paneCommands } from './pane'
import { permissionCommands } from './permissions'
import { profileCommands } from './profiles'
import { settingsCommands } from './settings'
import { skillsCommands } from './skills'
import { spacesCommands } from './spaces'
import { statusCommands } from './status'
import { tabsCommands } from './tabs'
import { tooltipCommands } from './tooltip'

// Public types, re-exported so consumers keep importing from './commands'.
export type { CommandContext } from './context'
export type { NavigableContents, ProfileInfo, CommandResult, CommandHandler } from './registry'
export type { AppContext } from './app'
export type { BookmarkContext } from './bookmarks'
export type { BookmarkNode, BookmarkUrl, BookmarkFolder, BookmarkTree } from '../bookmark-store'
export type { CookieContext, CookieSink, ImportCookiesParams } from './cookies'
export type { DevtoolsContext } from './devtools'
export type { ExtensionsContext, ExtensionInfo } from './extensions'
export { toExtensionInfo } from './extensions'
export type { FindContext, FindStopAction } from './find'
export type { HistoryContext } from './history'
export type { HistoryEntry } from '../history-store'
export type { NavContext } from './navigation'
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
export type { TabsContext, TabInfo, TabKind } from './tabs'
export type { TooltipContext } from './tooltip'

export type CommandRegistry = CommandRegistryOf<CommandContext>

export function createCommandRegistry(): CommandRegistry {
  const commands: CommandMap<CommandContext> = {
    ...appCommands,
    ...bookmarksCommands,
    ...cookieCommands,
    ...devtoolsCommands,
    ...extensionsCommands,
    ...findCommands,
    ...historyCommands,
    ...navigationCommands,
    ...paletteCommands,
    ...paneCommands,
    ...permissionCommands,
    ...profileCommands,
    ...settingsCommands,
    ...skillsCommands,
    ...spacesCommands,
    ...statusCommands,
    ...tabsCommands,
    ...tooltipCommands
  }
  return buildRegistry(commands)
}
