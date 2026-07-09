// A fake CommandContext backed by an in-memory profile list, shared by the
// per-domain command tests. It mirrors what ProfileManager does (profiles have a
// stable id and a renamable label) without spinning up Electron or real windows.
// Not a *.test.ts file, so Vitest does not treat it as a suite.

import type { CommandContext, ProfileInfo } from '.'
import {
  emptyTabState,
  addTab,
  selectTab as selectTabPure,
  closeTab as closeTabPure,
  type TabState
} from '../tab-store'

export interface FakeContext {
  ctx: CommandContext
  loaded: string[]
  nav: string[]
  opened: string[]
  settingsOpened: boolean[]
  profiles: Array<ProfileInfo & { open: boolean }>
  focused: string | null
  /** Live view of the fake window's tabs (reassigned by tab commands). */
  tabState: () => TabState
  /** Live view of the fake window's tab-panel collapsed flag. */
  panelCollapsed: () => boolean
}

export function makeContext(focusedId: string | null = 'default'): FakeContext {
  const loaded: string[] = []
  const nav: string[] = []
  const opened: string[] = []
  const settingsOpened: boolean[] = []
  const state = {
    profiles: [{ id: 'default', label: 'Default', open: true }] as Array<
      ProfileInfo & { open: boolean }
    >,
    focused: focusedId as string | null,
    seq: 1,
    // A window always starts with one tab, like the real ProfileManager.
    tabs: addTab(emptyTabState(), { id: 'tab-1', title: '', url: 'home', favicon: null }),
    panelCollapsed: false,
    tabSeq: 1
  }
  const ctx: CommandContext = {
    getTargetWebContents: () => ({
      loadURL: (url: string) => {
        loaded.push(url)
      },
      goBack: () => {
        nav.push('back')
      },
      goForward: () => {
        nav.push('forward')
      }
    }),
    getTargetProfile: () => {
      const p = state.profiles.find((x) => x.id === state.focused)
      return p ? { id: p.id, label: p.label } : null
    },
    openProfile: (id: string) => {
      const profile = state.profiles.find((p) => p.id === id)
      if (!profile) throw new Error(`unknown profile: ${id}`)
      opened.push(id)
      const created = !profile.open
      profile.open = true
      state.focused = id
      return { id, created }
    },
    createProfile: (label?: string) => {
      const id = `id-${++state.seq}`
      const finalLabel = label ?? `Profile ${state.seq}`
      state.profiles.push({ id, label: finalLabel, open: true })
      opened.push(id)
      state.focused = id
      return { id, label: finalLabel }
    },
    renameProfile: (id: string, label: string) => {
      const profile = state.profiles.find((p) => p.id === id)
      if (!profile) throw new Error(`unknown profile: ${id}`)
      profile.label = label
      return { id, label }
    },
    listProfiles: () => ({ profiles: state.profiles, focused: state.focused }),
    openSettings: () => settingsOpened.push(true),
    newTab: (url?: string) => {
      const id = `tab-${++state.tabSeq}`
      const tab = { id, title: '', url: url ?? 'home', favicon: null }
      state.tabs = addTab(state.tabs, tab)
      return tab
    },
    closeTab: (id: string) => {
      if (!state.tabs.tabs.some((t) => t.id === id)) throw new Error(`unknown tab: ${id}`)
      if (state.tabs.tabs.length <= 1) return { closed: false }
      state.tabs = closeTabPure(state.tabs, id)
      return { closed: true }
    },
    selectTab: (id: string) => {
      if (!state.tabs.tabs.some((t) => t.id === id)) throw new Error(`unknown tab: ${id}`)
      state.tabs = selectTabPure(state.tabs, id)
      return { id }
    },
    listTabs: () => ({
      tabs: state.tabs.tabs,
      activeId: state.tabs.activeId,
      panelCollapsed: state.panelCollapsed
    }),
    toggleTabsPanel: (collapsed?: boolean) => {
      state.panelCollapsed = collapsed ?? !state.panelCollapsed
      return { collapsed: state.panelCollapsed }
    }
  }
  return {
    ctx,
    loaded,
    nav,
    opened,
    settingsOpened,
    profiles: state.profiles,
    focused: state.focused,
    tabState: () => state.tabs,
    panelCollapsed: () => state.panelCollapsed
  }
}
