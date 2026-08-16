import { describe, it, expect } from 'vitest'
import {
  formatFocus,
  parseArgs,
  resolveTabId,
  pickTabByUrl,
  buildExec,
  buildReload,
  buildPress,
  buildCall,
  buildConsole,
  buildScreenshot,
  absolutePath,
  formatScreenshot,
  formatTabs,
  formatConsole,
  formatWindows,
  resolveCode,
  TAB_BOUND,
  resolveTimeoutMs
  // @ts-expect-error — plain-ESM sibling module, no .d.ts (the CLI ships without a build),
} from './mira-core.mjs'

describe('parseArgs', () => {
  it('takes the first bare token as the command, the rest as positionals', () => {
    expect(parseArgs(['exec', 'document.title'])).toEqual({
      command: 'exec',
      positionals: ['document.title'],
      flags: {}
    })
  })

  it('reads --flag value and --flag=value', () => {
    expect(parseArgs(['use', '--url', 'localhost:8000']).flags).toEqual({ url: 'localhost:8000' })
    expect(parseArgs(['use', '--url=localhost:8000']).flags).toEqual({ url: 'localhost:8000' })
  })

  it('treats known boolean flags as true even when a token follows', () => {
    // `--json tabs` must NOT swallow `tabs` as the flag value.
    const { command, flags } = parseArgs(['--json', 'tabs'])
    expect(flags).toEqual({ json: true })
    expect(command).toBe('tabs')
  })

  it('a trailing value-flag with nothing after it becomes true', () => {
    expect(parseArgs(['reload', '--tab']).flags).toEqual({ tab: true })
  })

  it('maps -n to the new-tab boolean flag', () => {
    expect(parseArgs(['nav', 'example.com', '-n'])).toEqual({
      command: 'nav',
      positionals: ['example.com'],
      flags: { 'new-tab': true }
    })
    expect(parseArgs(['nav', 'example.com', '--new-tab']).flags).toEqual({ 'new-tab': true })
  })

  it('leaves a bare - as a positional (stdin), not a short flag', () => {
    expect(parseArgs(['exec', '-'])).toEqual({
      command: 'exec',
      positionals: ['-'],
      flags: {}
    })
  })
})

describe('resolveTabId — precedence --tab > $MIRA_TAB > null', () => {
  it('prefers the explicit flag', () => {
    expect(resolveTabId({ flagTab: 'aaa', envTab: 'bbb' })).toBe('aaa')
  })
  it('falls back to the env var', () => {
    expect(resolveTabId({ flagTab: undefined, envTab: 'bbb' })).toBe('bbb')
  })
  it('returns null when neither is set, and treats blanks/non-strings as unset', () => {
    expect(resolveTabId({})).toBeNull()
    expect(resolveTabId({ flagTab: '  ', envTab: '' })).toBeNull()
    expect(resolveTabId({ flagTab: true as unknown as string })).toBeNull()
  })
})

describe('pickTabByUrl', () => {
  const tabs = [
    { id: 'a', url: 'https://localhost:8000/forest' },
    { id: 'b', url: 'https://example.com' },
    { id: 'c', url: 'https://localhost:8000/other' }
  ]
  it('returns the single match', () => {
    expect(pickTabByUrl(tabs, 'example.com')).toEqual({ tab: tabs[1] })
  })
  it('errors on zero matches', () => {
    expect(pickTabByUrl(tabs, 'nope')).toEqual({ error: 'no tab matching "nope"' })
  })
  it('errors on ambiguity and returns the candidates', () => {
    const r = pickTabByUrl(tabs, 'localhost:8000')
    expect(r.error).toContain('ambiguous')
    expect(r.matches).toHaveLength(2)
  })
})

describe('buildExec — a stale tabId is passed through, never swapped', () => {
  it('omits tabId when none is resolved (active tab)', () => {
    expect(buildExec('1+1', null)).toEqual({ command: 'exec-js', params: { code: '1+1' } })
  })
  it('includes the tabId so the registry fails loudly if it is gone', () => {
    expect(buildExec('1+1', 'dead-id')).toEqual({
      command: 'exec-js',
      params: { code: '1+1', tabId: 'dead-id' }
    })
  })
})

describe('buildReload', () => {
  it('reloads the active tab via the plain command when no tab is pinned', () => {
    expect(buildReload(null)).toEqual({ command: 'reload' })
  })
  it('reloads a pinned tab through exec-js (reload has no tabId param)', () => {
    expect(buildReload('t1')).toEqual({
      command: 'exec-js',
      params: { code: "location.reload(); 'ok'", tabId: 't1' }
    })
  })
})

describe('buildConsole', () => {
  it('reads the active tab with no filters when nothing is pinned or passed', () => {
    expect(buildConsole(null)).toEqual({ command: 'get-console', params: {} })
  })
  it('targets a pinned tab and maps level/limit/since to server params', () => {
    expect(buildConsole('t1', { level: 'error', limit: '20', since: '5' })).toEqual({
      command: 'get-console',
      params: { tabId: 't1', minLevel: 'error', limit: 20, sinceSeq: 5 }
    })
  })
  it('ignores empty-string flags', () => {
    expect(buildConsole('t1', { level: '', limit: '' })).toEqual({
      command: 'get-console',
      params: { tabId: 't1' }
    })
  })
})

describe('formatConsole', () => {
  it('notes an empty capture rather than printing blank', () => {
    expect(formatConsole([])).toBe('(no console output captured for this tab)')
    expect(formatConsole(undefined)).toBe('(no console output captured for this tab)')
  })
  it('renders one line per entry with level, source, message and origin', () => {
    const out = formatConsole([
      {
        seq: 1,
        level: 'error',
        source: 'network',
        message: '403 Forbidden',
        url: 'https://a/x',
        lineNumber: 2
      }
    ])
    expect(out).toContain('ERROR')
    expect(out).toContain('[network]')
    expect(out).toContain('403 Forbidden')
    expect(out).toContain('(https://a/x:2)')
  })
})

describe('buildCall — generic passthrough', () => {
  it('sends a bare command when there are no params', () => {
    expect(buildCall('focus-app', undefined, null)).toEqual({ request: { command: 'focus-app' } })
  })
  it('parses --params JSON', () => {
    expect(buildCall('select-tab', '{"id":"x"}', null)).toEqual({
      request: { command: 'select-tab', params: { id: 'x' } }
    })
  })
  it('injects tabId only for TAB_BOUND commands', () => {
    expect(buildCall('collect-media', undefined, 't1').request).toEqual({
      command: 'collect-media',
      params: { tabId: 't1' }
    })
    // select-tab wants `id`, not `tabId` — must not be injected.
    expect(buildCall('select-tab', '{"id":"x"}', 't1').request).toEqual({
      command: 'select-tab',
      params: { id: 'x' }
    })
    expect(TAB_BOUND.has('exec-js')).toBe(true)
    // get-console is tab-bound too, so `mira get-console` respects the pinned tab.
    expect(buildCall('get-console', undefined, 't1').request).toEqual({
      command: 'get-console',
      params: { tabId: 't1' }
    })
  })
  it('does not override a tabId the caller already set', () => {
    expect(
      buildCall('exec-js', '{"code":"1","tabId":"explicit"}', 'env-tab').request.params
    ).toEqual({
      code: '1',
      tabId: 'explicit'
    })
  })
  it('errors on invalid or non-object JSON', () => {
    expect('error' in buildCall('x', '{bad', null)).toBe(true)
    expect('error' in buildCall('x', '[1,2]', null)).toBe(true)
  })
})

describe('formatTabs', () => {
  it('marks the active tab with * and the rest with a space', () => {
    const out = formatTabs(
      [
        { id: 'a', url: 'u1', title: 't1' },
        { id: 'b', url: 'u2', title: 't2' }
      ],
      'b'
    )
    const lines = out.split('\n')
    expect(lines[0].startsWith(' ')).toBe(true)
    expect(lines[1].startsWith('*')).toBe(true)
    expect(lines[1]).toContain('b')
  })

  it('marks an asleep tab (loaded===false) with z, unless it is active', () => {
    const out = formatTabs(
      [
        { id: 'a', url: 'u1', title: 't1', loaded: false },
        { id: 'b', url: 'u2', title: 't2', loaded: true },
        { id: 'c', url: 'u3', title: 't3', loaded: false }
      ],
      'c'
    )
    const lines = out.split('\n')
    expect(lines[0].startsWith('z')).toBe(true) // asleep
    expect(lines[1].startsWith(' ')).toBe(true) // loaded, not active
    expect(lines[2].startsWith('*')).toBe(true) // active wins over asleep
  })

  it('marks an audible tab with ♪ in the second column, independent of the first', () => {
    const out = formatTabs(
      [
        { id: 'a', url: 'u1', title: 't1', audible: true },
        { id: 'b', url: 'u2', title: 't2', audible: true },
        { id: 'c', url: 'u3', title: 't3' }
      ],
      'b'
    )
    const lines = out.split('\n')
    expect(lines[0].startsWith(' ♪')).toBe(true) // audible, not active
    expect(lines[1].startsWith('*♪')).toBe(true) // active AND audible
    expect(lines[2].startsWith('  ')).toBe(true) // silent
  })
})

describe('buildPress', () => {
  it('builds a press-key request with just a key', () => {
    expect(buildPress('e', null, [])).toEqual({
      request: { command: 'press-key', params: { key: 'e' } }
    })
  })

  it('includes tabId and modifiers when given', () => {
    expect(buildPress('a', 't1', ['meta', 'shift'])).toEqual({
      request: {
        command: 'press-key',
        params: { key: 'a', tabId: 't1', modifiers: ['meta', 'shift'] }
      }
    })
  })

  it('errors on a missing key', () => {
    expect(buildPress('', null, [])).toEqual({ error: 'press needs a key' })
  })
})

describe('formatWindows', () => {
  it('marks the focused window with * and shows profile + tab count', () => {
    const out = formatWindows([
      { windowId: 'w1', profileId: 'default', tabCount: 3, focused: false },
      { windowId: 'w2', profileId: 'perso', tabCount: 7, focused: true }
    ])
    const lines = out.split('\n')
    expect(lines[0].startsWith(' ')).toBe(true)
    expect(lines[0]).toContain('tabs=3')
    expect(lines[1].startsWith('*')).toBe(true)
    expect(lines[1]).toContain('w2')
  })
})

describe('TAB_BOUND includes press-key', () => {
  it('so a generic call injects the resolved tabId', () => {
    expect(TAB_BOUND.has('press-key')).toBe(true)
  })
})

describe('resolveCode', () => {
  const io = { readStdin: () => 'from-stdin', readFile: (p: string) => `file:${p}` }
  it('uses the positional as literal code', () => {
    expect(resolveCode('document.title', io)).toEqual({ code: 'document.title' })
  })
  it('reads stdin for -', () => {
    expect(resolveCode('-', io)).toEqual({ code: 'from-stdin' })
  })
  it('reads a file for @path', () => {
    expect(resolveCode('@/tmp/x.js', io)).toEqual({ code: 'file:/tmp/x.js' })
  })
  it('errors when nothing is given', () => {
    expect('error' in resolveCode(undefined, io)).toBe(true)
  })
})

describe("absolutePath — resolved in the caller's shell, never in Mira", () => {
  const env = { cwd: '/work/self/files/cgm', home: '/Users/mickaelfm' }

  it('leaves an absolute path alone', () => {
    expect(absolutePath('/tmp/cgm.png', env)).toBe('/tmp/cgm.png')
  })

  it('expands a leading ~ (a quoted one survives the shell)', () => {
    expect(absolutePath('~/Downloads/cgm.png', env)).toBe('/Users/mickaelfm/Downloads/cgm.png')
    expect(absolutePath('~', env)).toBe('/Users/mickaelfm')
  })

  it("hangs a relative path off the calling shell's cwd", () => {
    expect(absolutePath('cgm.png', env)).toBe('/work/self/files/cgm/cgm.png')
    expect(absolutePath('./cgm.png', env)).toBe('/work/self/files/cgm/cgm.png')
  })
})

describe('buildScreenshot', () => {
  const env = { cwd: '/work', home: '/Users/mickaelfm' }

  it('sends no path at all when none was given (the daemon defaults it)', () => {
    expect(buildScreenshot(undefined, null, env)).toEqual({
      request: { command: 'screenshot', params: {} }
    })
  })

  it('makes the path absolute and carries the pinned tab', () => {
    expect(buildScreenshot('shot.png', 'tab-9', env).request.params).toEqual({
      path: '/work/shot.png',
      tabId: 'tab-9'
    })
  })

  it('only sets fullPage when asked, as a real boolean', () => {
    expect(buildScreenshot(undefined, null, { ...env, full: true }).request.params).toEqual({
      fullPage: true
    })
    expect(buildScreenshot(undefined, null, env).request.params.fullPage).toBeUndefined()
  })
})

describe('formatScreenshot', () => {
  it('reads as one line: where, how big, what scope', () => {
    expect(formatScreenshot({ path: '/tmp/a.png', width: 1280, height: 720, bytes: 51200 })).toBe(
      '/tmp/a.png  1280×720  50 KB  (viewport)'
    )
  })

  it('says out loud when the page was cut off', () => {
    const line = formatScreenshot({
      path: '/tmp/a.png',
      width: 1280,
      height: 16384,
      bytes: 1024,
      fullPage: true,
      clamped: true
    })
    expect(line).toContain('full page')
    expect(line).toContain('CUT OFF')
  })
})

describe('TAB_BOUND includes screenshot', () => {
  it('so `mira call screenshot` targets the pinned tab like the shorthand does', () => {
    expect(TAB_BOUND.has('screenshot')).toBe(true)
    expect(buildCall('screenshot', undefined, 'tab-3').request.params).toEqual({ tabId: 'tab-3' })
  })
})

describe('formatFocus', () => {
  const tab = {
    windowId: 'w1',
    profileId: 'default',
    profileLabel: 'pro: lempire',
    tabId: 't1',
    url: 'https://app.trykondo.com/',
    title: 'Kondo',
    folderId: null,
    folderTitle: null
  }

  it('shows the profile, the title and the url', () => {
    const line = formatFocus(tab)
    expect(line).toContain('[pro: lempire]')
    expect(line).toContain('Kondo')
    expect(line).toContain('https://app.trykondo.com/')
  })

  it('adds the folder when the tab is in one', () => {
    expect(formatFocus({ ...tab, folderId: 'f1', folderTitle: 'Prod' })).toContain(
      '[pro: lempire / Prod]'
    )
  })

  it('prints leaving the browser as an event of its own', () => {
    expect(formatFocus(null)).toContain('not frontmost')
  })
})

describe('resolveTimeoutMs', () => {
  it('defaults to 30 seconds', () => {
    expect(resolveTimeoutMs({})).toBe(30000)
  })

  it('reads --timeout in seconds (a human typing a master password needs more)', () => {
    expect(resolveTimeoutMs({ timeout: '300' })).toBe(300000)
  })

  it('falls back on junk, zero and a bare flag', () => {
    expect(resolveTimeoutMs({ timeout: 'soon' })).toBe(30000)
    expect(resolveTimeoutMs({ timeout: '0' })).toBe(30000)
    expect(resolveTimeoutMs({ timeout: '-5' })).toBe(30000)
    expect(resolveTimeoutMs({ timeout: true })).toBe(30000)
  })
})
