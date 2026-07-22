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
    focusApp: () => {},
    quitApp: () => {},
    openExternalUrl: () => {},
    getSpacesState: () => ({ displays: [], window: null }),
    moveTargetWindowToSpace: () => 'noop',
    getTargetWebContents: () => ({
      loadURL: (url: string) => {
        loaded.push(url)
      },
      goBack: () => {},
      goForward: () => {},
      reload: () => {},
      reloadIgnoringCache: () => {},
      getZoomLevel: () => 0,
      setZoomLevel: () => {}
    }),
    getTargetProfile: () => ({ id: focused, label: focused }),
    openFindBar: () => {},
    findInPage: () => {},
    findStep: () => false,
    stopFindInPage: () => {},
    openProfile: (id: string) => {
      focused = id
      return { id, created: true }
    },
    closeProfile: (id: string) => ({ id, closed: true }),
    createProfile: (label?: string) => ({ id: 'new', label: label ?? 'Profile 2' }),
    renameProfile: (id: string, label: string) => ({ id, label }),
    setProfileColor: (id: string, color: string | null) => ({
      id,
      label: id,
      ...(color ? { color } : {})
    }),
    listProfiles: () => ({ profiles: [{ id: focused, label: focused, open: true }], focused }),
    listThemes: () => [],
    createTheme: (input) => ({ id: 'x', name: input.name, background: input.background, text: input.text }),
    updateTheme: (id, patch) => ({ id, name: patch.name ?? id, background: '#000', text: '#fff' }),
    deleteTheme: (id: string) => ({ id }),
    setProfileTheme: (id: string, themeId: string | null) => ({
      id,
      label: id,
      ...(themeId ? { themeId } : {})
    }),
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
    diskUsage: () => ({ root: '/fake', total: 0, reclaimable: 0, entries: [], profiles: [] }),
    cookieJarForProfile: () => ({ set: () => Promise.resolve() }),
    countActiveSiteCookies: () => Promise.resolve({ url: null, count: 0 }),
    readActiveSiteCookies: () => Promise.resolve({ url: null, cookie: '', count: 0 }),
    clearProfileData: (profileId?: string) => Promise.resolve({ id: profileId ?? focused }),
    clearSiteData: () => Promise.resolve(null),
    forgetActiveSite: () => ({
      domain: null,
      closed: false,
      tabId: null,
      done: Promise.resolve({ cookiesRemoved: 0, historyRemoved: 0 })
    }),
    forgetDomain: () => Promise.resolve({ domain: null, cookiesRemoved: 0, historyRemoved: 0 }),
    getMemoryUsage: () => ({ rss: 0, processes: 1 }),
    listTabMemory: () => ({ entries: [], tabsBytes: 0, otherBytes: 0, totalBytes: 0 }),
    getTabCounts: () => ({ total: 0, loaded: 0, asleep: 0 }),
    collectMedia: async () => [],
    downloadMedia: async () => ({ saved: 0, failed: [] }),
    downloadVideoUrl: async () => ({ saved: true, file: 'clip.mp4' }),
    getMediaStats: () => ({ count: 0, bytes: 0 }),
    setMediaGalleryOpen: (open) => ({ open: open ?? true }),
    // Downloads slice: minimal stubs, not exercised by these socket-dispatch tests.
    listDownloads: () => [],
    cancelDownload: () => false,
    openDownload: async () => false,
    revealDownload: () => false,
    clearDownloads: () => 0,
    getDownloadStats: () => ({ active: 0, since: null, receivedBytes: 0, totalBytes: 0 }),
    // Tab slice: minimal stubs, not exercised by these socket-dispatch tests.
    newTab: (url?: string) => ({
      id: 'tab',
      title: '',
      url: url ?? 'home',
      favicon: null,
      loaded: true,
      folderId: null,
      kind: 'web' as const,
      pinned: false,
      keepAwake: false,
      audible: false,
      loading: false
    }),
    closeTab: () => ({ closed: true }),
    closeActiveTab: () => ({ closed: true, id: 'tab' }),
    duplicateActiveTab: () => ({ duplicated: true, id: 'tab', url: '' }),
    discardTab: (id: string) => ({ discarded: true, id }),
    discardActiveTab: () => ({ discarded: true, id: 'tab' }),
    wakeAllTabs: () => ({ woken: 0 }),
    selectTab: (id: string) => ({ id }),
    selectPrevTab: () => ({ id: null }),
    selectNextTab: () => ({ id: null }),
    recentTabBack: () => ({ id: null }),
    recentTabForward: () => ({ id: null }),
    reopenClosedTab: () => ({ reopened: false, id: null }),
    moveTab: (id: string) => ({ id }),
    detachTab: async () => ({ windowId: 'w', created: true }),
    moveTabToWindow: (_id: string, windowId: string) => ({ windowId }),
    activateTab: (id: string) => ({ windowId: 'w', id }),
    listWindows: () => [],
    pinTab: (id: string) => ({ id, pinned: true }),
    unpinTab: (id: string) => ({ id, pinned: false }),
    setTabKeepAwake: (id: string, keepAwake: boolean) => ({ id, keepAwake }),
    listTabs: () => ({
      tabs: [
        {
          id: 'tab',
          title: '',
          url: 'home',
          favicon: null,
          loaded: true,
          kind: 'web' as const,
          pinned: false,
          keepAwake: false,
          folderId: null,
          audible: false,
          loading: false
        }
      ],
      activeId: 'tab',
      panelCollapsed: false
    }),
    toggleTabsPanel: (collapsed?: boolean) => ({ collapsed: collapsed ?? true }),
    showTabMenu: () => {},
    showAudioMenu: () => {},
    listTabFolders: () => ({ folders: [] }),
    createTabFolder: () => ({ id: 'folder-1' }),
    renameTabFolder: () => ({ renamed: true }),
    removeTabFolder: () => ({ removed: true }),
    toggleTabFolder: (_id: string, collapsed?: boolean) => ({ collapsed: collapsed ?? true }),
    setTabFolderColor: () => ({ updated: true }),
    showFolderMenu: () => {},
    moveTabToFolder: () => ({ moved: true }),
    toggleZen: (hidden?: boolean) => ({ hidden: hidden ?? true }),
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
    showToast: () => {},
    // Magnifier slice: minimal stubs, not exercised by these socket-dispatch tests.
    magnifierTarget: () => null,
    getMagnifierState: () => ({ scale: 1, originX: 0, originY: 0 }),
    setMagnifierState: () => {},
    applyMagnifierClip: () => {},
    magnifierFlash: () => {},
    // Permissions slice: minimal stubs, not exercised by these socket-dispatch tests.
    listPermissions: () => [],
    clearPermissions: () => ({ cleared: 0 }),
    encryptProfile: async (id: string) => ({ id }),
    unlockProfile: async (id: string) => ({ id }),
    lockProfile: async (id: string) => ({ id, locked: true }),
    lockAllVaults: async () => ({ locked: [] }),
    listVaults: () => ({ encrypted: [], unlocked: [] }),
    openLocationSettings: () => ({ opened: true }),
    locationAuthStatus: () => 'authorized' as const,
    requestLocationAuthorization: () => 'authorized' as const,
    execJsInTab: (code: string) => Promise.resolve(`ran:${code}`),
    pressKeyInTab: () => Promise.resolve(),
    toggleDevToolsInActiveTab: () => true,
    inspectCookiesInActiveTab: () => Promise.resolve(true),
    // Skills slice: minimal stubs, not exercised by these socket-dispatch tests.
    activeUrl: () => null,
    extractText: () => Promise.resolve(''),
    capturePage: () => Promise.resolve(null),
    summarize: (_prompt: string, text: string) => Promise.resolve(text),
    chat: () => Promise.resolve(''),
    // Extensions slice: minimal stubs (loadExtension async, so the socket's
    // await-a-promise path is exercisable — see the async dispatch test).
    listExtensions: () => [],
    loadExtension: (path: string) =>
      Promise.resolve({ id: 'ext-1', name: 'Fake', version: '1.0.0', path, enabled: true }),
    installExtension: (id: string) =>
      Promise.resolve({
        id,
        name: 'Fake',
        version: '1.0.0',
        path: `/extensions/${id}`,
        enabled: true
      }),
    updateExtensions: () => Promise.resolve(),
    disableExtension: (id: string) =>
      Promise.resolve({ id, name: 'Fake', version: '1.0.0', path: `/ext/${id}`, enabled: false }),
    enableExtension: (id: string) =>
      Promise.resolve({ id, name: 'Fake', version: '1.0.0', path: `/ext/${id}`, enabled: true }),
    uninstallExtension: () => Promise.resolve({ removed: true }),
    readServiceWorkerConsole: () => [],
    readPageConsole: () => [],
    // Skill pane slice: minimal stubs.
    showSkillPane: () => {},
    closeSkillPane: () => {},
    getSkillPane: () => ({ open: false, title: '', status: 'idle' as const, messages: [] }),
    writeClipboard: () => {}
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

  it('accepts "cmd" as an alias for "command"', () => {
    const { registry, ctx, loaded } = setup()
    const res = handleRequestLine(
      '{"cmd":"navigate","params":{"url":"example.com"}}',
      registry,
      ctx
    )
    expect(res).toEqual({ ok: true, url: 'https://example.com' })
    expect(loaded).toEqual(['https://example.com'])
  })

  it('prefers "command" over "cmd" when both are present', () => {
    const { registry, ctx } = setup()
    expect(handleRequestLine('{"command":"fly","cmd":"navigate"}', registry, ctx)).toEqual({
      ok: false,
      error: 'Unknown command: fly'
    })
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

  it('resolves an async command (the socket loop awaits the promise)', async () => {
    const { registry, ctx } = setup()
    const res = await handleRequestLine(
      '{"command":"load-extension","params":{"path":"/ext/dark-reader"}}',
      registry,
      ctx
    )
    expect(res).toEqual({
      ok: true,
      extension: {
        id: 'ext-1',
        name: 'Fake',
        version: '1.0.0',
        path: '/ext/dark-reader',
        enabled: true
      }
    })
  })
})
