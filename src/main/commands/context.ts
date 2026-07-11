// The composed command context: the intersection of every domain's capability
// slice. A command receives this whole object but uses only its own slice.
//
// This is the counterpart to the flat registry split: instead of one god
// interface everyone extends (and collides on), each domain owns its slice in
// its own file. Extending a capability = editing that domain's slice; only a
// brand-new domain touches the intersection below.

import type { AppContext } from './app'
import type { BookmarkContext } from './bookmarks'
import type { CookieContext } from './cookies'
import type { DevtoolsContext } from './devtools'
import type { ExtensionsContext } from './extensions'
import type { FindContext } from './find'
import type { HistoryContext } from './history'
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
import type { TabsContext } from './tabs'
import type { TooltipContext } from './tooltip'
import type { VaultContext } from './vault'

export type CommandContext = AppContext &
  BookmarkContext &
  CookieContext &
  DevtoolsContext &
  ExtensionsContext &
  FindContext &
  HistoryContext &
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
  TabsContext &
  TooltipContext &
  VaultContext
