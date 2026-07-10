// The composed command context: the intersection of every domain's capability
// slice. A command receives this whole object but uses only its own slice.
//
// This is the counterpart to the flat registry split: instead of one god
// interface everyone extends (and collides on), each domain owns its slice in
// its own file. Extending a capability = editing that domain's slice; only a
// brand-new domain touches the intersection below.

import type { BookmarkContext } from './bookmarks'
import type { CookieContext } from './cookies'
import type { DevtoolsContext } from './devtools'
import type { HistoryContext } from './history'
import type { NavContext } from './navigation'
import type { PaletteContext } from './palette'
import type { PaneContext } from './pane'
import type { PermissionContext } from './permissions'
import type { ProfileContext } from './profiles'
import type { SettingsContext } from './settings'
import type { SkillsContext } from './skills'
import type { StatusContext } from './status'
import type { TabsContext } from './tabs'
import type { TooltipContext } from './tooltip'

export type CommandContext = BookmarkContext &
  CookieContext &
  DevtoolsContext &
  HistoryContext &
  NavContext &
  PaletteContext &
  PaneContext &
  PermissionContext &
  ProfileContext &
  SettingsContext &
  SkillsContext &
  StatusContext &
  TabsContext &
  TooltipContext
