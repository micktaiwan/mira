// The composed command context: the intersection of every domain's capability
// slice. A command receives this whole object but uses only its own slice.
//
// This is the counterpart to the flat registry split: instead of one god
// interface everyone extends (and collides on), each domain owns its slice in
// its own file. Extending a capability = editing that domain's slice; only a
// brand-new domain touches the intersection below.

import type { BookmarkContext } from './bookmarks'
import type { NavContext } from './navigation'
import type { ProfileContext } from './profiles'
import type { SettingsContext } from './settings'
import type { StatusContext } from './status'
import type { TabsContext } from './tabs'
import type { TooltipContext } from './tooltip'

export type CommandContext = BookmarkContext &
  NavContext &
  ProfileContext &
  SettingsContext &
  StatusContext &
  TabsContext &
  TooltipContext
