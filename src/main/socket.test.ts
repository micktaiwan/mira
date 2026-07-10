import { describe, it, expect } from 'vitest'
import { handleRequestLine } from './socket'
import { createCommandRegistry, type CommandContext } from './commands'

function setup(): {
  registry: ReturnType<typeof createCommandRegistry>
  ctx: CommandContext
  loaded: string[]
} {
  const loaded: string[] = []
  let focused = 'default'
  const ctx: CommandContext = {
    getTargetWebContents: () => ({
      loadURL: (url: string) => {
        loaded.push(url)
      },
      goBack: () => {},
      goForward: () => {},
      reload: () => {},
      getZoomLevel: () => 0,
      setZoomLevel: () => {}
    }),
    getTargetProfile: () => ({ id: focused, label: focused }),
    openProfile: (id: string) => {
      focused = id
      return { id, created: true }
    },
    createProfile: (label?: string) => ({ id: 'new', label: label ?? 'Profile 2' }),
    renameProfile: (id: string, label: string) => ({ id, label }),
    listProfiles: () => ({ profiles: [{ id: focused, label: focused, open: true }], focused }),
    openSettings: () => {},
    getSettings: () => ({
      homeUrl: 'home',
      llm: { provider: 'claude-cli' },
      sidebarWidth: 240,
      skillPaneWidth: 360
    }),
    setLlmConfig: (llm) => ({ homeUrl: 'home', llm, sidebarWidth: 240, skillPaneWidth: 360 }),
    setSidebarWidth: (width) => ({
      homeUrl: 'home',
      llm: { provider: 'claude-cli' },
      sidebarWidth: width,
      skillPaneWidth: 360
    }),
    setSkillPaneWidth: (width) => ({
      homeUrl: 'home',
      llm: { provider: 'claude-cli' },
      sidebarWidth: 240,
      skillPaneWidth: width
    }),
    setHomeUrl: (url: string) => ({
      homeUrl: url,
      llm: { provider: 'claude-cli' },
      sidebarWidth: 240,
      skillPaneWidth: 360
    }),
    cookieJarForProfile: () => ({ set: () => Promise.resolve() }),
    countActiveSiteCookies: () => Promise.resolve({ url: null, count: 0 }),
    clearProfileData: (profileId?: string) => Promise.resolve({ id: profileId ?? focused }),
    clearSiteData: () => Promise.resolve(null),
    getMemoryUsage: () => ({ rss: 0, processes: 1 }),
    getTabCounts: () => ({ total: 0, loaded: 0, asleep: 0 }),
    // Tab slice: minimal stubs, not exercised by these socket-dispatch tests.
    newTab: (url?: string) => ({
      id: 'tab',
      title: '',
      url: url ?? 'home',
      favicon: null,
      loaded: true,
      kind: 'web' as const,
      pinned: false
    }),
    closeTab: () => ({ closed: true }),
    closeActiveTab: () => ({ closed: true, id: 'tab' }),
    discardTab: (id: string) => ({ discarded: true, id }),
    discardActiveTab: () => ({ discarded: true, id: 'tab' }),
    selectTab: (id: string) => ({ id }),
    selectPrevTab: () => ({ id: null }),
    selectNextTab: () => ({ id: null }),
    reopenClosedTab: () => ({ reopened: false, id: null }),
    moveTab: (id: string) => ({ id }),
    pinTab: (id: string) => ({ id, pinned: true }),
    unpinTab: (id: string) => ({ id, pinned: false }),
    listTabs: () => ({
      tabs: [
        {
          id: 'tab',
          title: '',
          url: 'home',
          favicon: null,
          loaded: true,
          kind: 'web' as const,
          pinned: false
        }
      ],
      activeId: 'tab',
      panelCollapsed: false
    }),
    toggleTabsPanel: (collapsed?: boolean) => ({ collapsed: collapsed ?? true }),
    setPaletteOpen: (open?: boolean) => ({ open: open ?? true }),
    // Bookmark slice: minimal stubs, not exercised by these socket-dispatch tests.
    addBookmark: (url?: string, title?: string) => ({
      node: { id: 'bm', kind: 'url' as const, url: url ?? 'home', title: title ?? '' },
      created: true
    }),
    addFolder: (title: string) => ({
      node: { id: 'f', kind: 'folder' as const, title, children: [] }
    }),
    removeBookmark: () => ({ removed: true }),
    renameBookmark: (id: string, title: string) => ({
      node: { id, kind: 'url' as const, url: 'home', title }
    }),
    moveBookmark: () => ({ moved: true }),
    listBookmarks: () => ({ tree: [] }),
    openBookmark: (id: string) => ({ tabId: 'tab', url: id }),
    // History slice: minimal stubs, not exercised by these socket-dispatch tests.
    listHistory: () => [],
    searchHistory: () => [],
    clearHistory: () => ({ cleared: 0 }),
    showTooltip: () => ({ shown: true }),
    hideTooltip: () => ({ hidden: true }),
    execJsInActiveTab: (code: string) => Promise.resolve(`ran:${code}`),
    // Skills slice: minimal stubs, not exercised by these socket-dispatch tests.
    activeUrl: () => null,
    extractText: () => Promise.resolve(''),
    summarize: (_prompt: string, text: string) => Promise.resolve(text),
    // Skill pane slice: minimal stubs.
    showSkillPane: () => {},
    closeSkillPane: () => {},
    getSkillPane: () => ({ open: false, title: '', status: 'done' as const })
  }
  return { registry: createCommandRegistry(), ctx, loaded }
}

describe('handleRequestLine', () => {
  it('dispatches a valid navigate request to the registry', () => {
    const { registry, ctx, loaded } = setup()
    const res = handleRequestLine(
      '{"command":"navigate","params":{"url":"example.com"}}',
      registry,
      ctx
    )
    expect(res).toEqual({ ok: true, url: 'https://example.com' })
    expect(loaded).toEqual(['https://example.com'])
  })

  it('rejects invalid JSON', () => {
    const { registry, ctx } = setup()
    expect(handleRequestLine('{not json', registry, ctx)).toEqual({
      ok: false,
      error: 'invalid JSON'
    })
  })

  it('rejects a message with no command field', () => {
    const { registry, ctx } = setup()
    expect(handleRequestLine('{"params":{}}', registry, ctx)).toEqual({
      ok: false,
      error: 'missing "command" field'
    })
  })

  it('turns an unknown command into an error response instead of throwing', () => {
    const { registry, ctx } = setup()
    expect(handleRequestLine('{"command":"fly"}', registry, ctx)).toEqual({
      ok: false,
      error: 'Unknown command: fly'
    })
  })
})
