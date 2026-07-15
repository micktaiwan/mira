import { describe, it, expect } from 'vitest'
import {
  parseArgs,
  resolveTabId,
  pickTabByUrl,
  buildExec,
  buildReload,
  buildCall,
  formatTabs,
  resolveCode,
  TAB_BOUND
  // @ts-expect-error — plain-ESM sibling module, no .d.ts (the CLI ships without a build)
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
