// The composed command context: the intersection of every domain's capability
// slice. A command receives this whole object but uses only its own slice.
//
// This is the counterpart to the flat registry split: instead of one god
// interface everyone extends (and collides on), each domain owns its slice in
// its own file. Extending a capability = editing that domain's slice; only a
// brand-new domain touches the intersection below.

import type { AppContext } from './app'
import type { AudioContext } from './audio'
import type { BookmarkContext } from './bookmarks'
import type { CookieContext } from './cookies'
import type { DevtoolsContext } from './devtools'
import type { DiskContext } from './disk'
import type { DownloadsContext } from './downloads'
import type { ExtensionsContext } from './extensions'
import type { FindContext } from './find'
import type { FolderMenuContext } from './folder-menu'
import type { ForgetContext } from './forget'
import type { HistoryContext } from './history'
import type { InputContext } from './input'
import type { MagnifierContext } from './magnifier'
import type { MediaContext } from './media'
import type { NavContext } from './navigation'
import type { OpenContext } from './open'
import type { PaletteContext } from './palette'
import type { PaneContext } from './pane'
import type { PermissionContext } from './permissions'
import type { ProfileContext } from './profiles'
import type { SettingsContext } from './settings'
import type { SkillsContext } from './skills'
import type { SpacesContext } from './spaces'
import type { StatusContext } from './status'
import type { TabDetachContext } from './tab-detach'
import type { TabFoldersContext } from './tab-folders'
import type { TabMemoryContext } from './tab-memory'
import type { TabMenuContext } from './tab-menu'
import type { TabsContext } from './tabs'
import type { ThemeContext } from './themes'
import type { ToastContext } from './toast'
import type { TooltipContext } from './tooltip'
import type { VaultContext } from './vault'
import type { ZenContext } from './zen'

export type CommandContext = AppContext &
  AudioContext &
  BookmarkContext &
  CookieContext &
  DevtoolsContext &
  DiskContext &
  DownloadsContext &
  ExtensionsContext &
  FindContext &
  FolderMenuContext &
  ForgetContext &
  HistoryContext &
  InputContext &
  MagnifierContext &
  MediaContext &
  NavContext &
  OpenContext &
  PaletteContext &
  PaneContext &
  PermissionContext &
  ProfileContext &
  SettingsContext &
  SkillsContext &
  SpacesContext &
  StatusContext &
  TabDetachContext &
  TabFoldersContext &
  TabMemoryContext &
  TabMenuContext &
  TabsContext &
  ThemeContext &
  ToastContext &
  TooltipContext &
  VaultContext &
  ZenContext
