// Tests for the batch/click/wait half of the CLI core. Kept in its own file
// rather than appended to mira-core.test.ts: that file is edited by whoever
// touches an existing verb, and Mira is written from several sessions at once
// (CLAUDE.md) — a separate suite is one less shared line.
import { describe, it, expect } from 'vitest'
import {
  tokenizeLine,
  parseBatchScript,
  buildLineRequest,
  buildBatch,
  formatBatchResults,
  buildClick,
  buildWait
  // @ts-expect-error — plain-ESM sibling module, no .d.ts (the CLI ships without a build),
} from './mira-core.mjs'

const env = { cwd: '/work', home: '/Users/me' }

describe('tokenizeLine', () => {
  it('splits on whitespace', () => {
    expect(tokenizeLine('press Enter --mod meta')).toEqual({
      argv: ['press', 'Enter', '--mod', 'meta']
    })
  })

  it('keeps a quoted argument in one piece, quotes stripped', () => {
    expect(tokenizeLine(`click --text 'Settings and members'`).argv).toEqual([
      'click',
      '--text',
      'Settings and members'
    ])
    expect(tokenizeLine('exec "document.title"').argv).toEqual(['exec', 'document.title'])
  })

  it('keeps an empty quoted argument (it is an argument)', () => {
    expect(tokenizeLine("exec ''").argv).toEqual(['exec', ''])
  })

  it('honours a backslash escape outside quotes', () => {
    expect(tokenizeLine('click --text hello\\ world').argv).toEqual([
      'click',
      '--text',
      'hello world'
    ])
  })

  it('refuses an unterminated quote rather than guessing', () => {
    expect(tokenizeLine(`click --text 'oops`)).toEqual({ error: 'unterminated single quote' })
  })
})

describe('parseBatchScript', () => {
  it('drops comments and blank lines, keeping original line numbers', () => {
    const r = parseBatchScript(
      ['# open the dialog', '', 'press , --mod meta', '', '# done'].join('\n')
    )
    expect(r.lines).toEqual([
      { lineNo: 3, source: 'press , --mod meta', argv: ['press', ',', '--mod', 'meta'] }
    ])
  })

  it('names the line of a quoting error', () => {
    expect(parseBatchScript(`tabs\nclick --text 'x`).error).toBe(
      'line 2: unterminated single quote'
    )
  })

  it('refuses an empty script instead of reporting a vacuous success', () => {
    expect(parseBatchScript('# nothing\n\n').error).toMatch(/no command lines/)
  })
})

describe('buildLineRequest', () => {
  it('maps exec, press and reload like the interactive CLI does', () => {
    expect(buildLineRequest(['exec', 'document.title'], env)).toEqual({
      request: { command: 'exec-js', params: { code: 'document.title' } }
    })
    expect(buildLineRequest(['press', 'Enter', '--mod', 'meta'], env)).toEqual({
      request: { command: 'press-key', params: { key: 'Enter', modifiers: ['meta'] } }
    })
    expect(buildLineRequest(['reload'], env)).toEqual({ request: { command: 'reload' } })
  })

  it('applies the batch-level tab, and lets a line override it', () => {
    const withTab = { ...env, tabId: 'tab-a' }
    expect(buildLineRequest(['exec', '1'], withTab).request.params.tabId).toBe('tab-a')
    expect(buildLineRequest(['exec', '1', '--tab', 'tab-b'], withTab).request.params.tabId).toBe(
      'tab-b'
    )
  })

  it('reads exec code from @file through the injected reader', () => {
    const r = buildLineRequest(['exec', '@probe.js'], { ...env, readFile: () => 'window.x' })
    expect(r.request.params.code).toBe('window.x')
  })

  it('refuses exec from stdin: a batch has no stdin of its own', () => {
    expect(buildLineRequest(['exec', '-'], env).error).toMatch(/stdin/)
  })

  it('refuses nav/open with no tab target rather than guessing a window', () => {
    const r = buildLineRequest(['nav', 'example.com'], env)
    expect(r.error).toMatch(/needs a tab target/)
    expect(buildLineRequest(['nav', 'example.com'], { ...env, tabId: 't1' })).toEqual({
      request: { command: 'navigate', params: { url: 'example.com', tabId: 't1' } }
    })
  })

  it('opens into a new tab', () => {
    expect(buildLineRequest(['open', 'example.com', '-b'], { ...env, tabId: 't1' })).toEqual({
      request: {
        command: 'navigate',
        params: { url: 'example.com', newTab: true, background: true, tabId: 't1' }
      }
    })
  })

  it('refuses the verbs a batch cannot carry, naming why', () => {
    expect(buildLineRequest(['watch'], env).error).toMatch(/streams forever/)
    expect(buildLineRequest(['use', '--active'], env).error).toMatch(/calling shell/)
    expect(buildLineRequest(['batch', '@x'], env).error).toMatch(/cannot nest/)
  })

  it('falls back to the generic passthrough for any other command', () => {
    expect(buildLineRequest(['select-tab', '--params', '{"id":"t9"}'], env)).toEqual({
      request: { command: 'select-tab', params: { id: 't9' } }
    })
  })

  it('makes a screenshot path absolute against the calling shell cwd', () => {
    const r = buildLineRequest(['shot', 'out.png'], env)
    expect(r.request.params.path).toBe('/work/out.png')
  })
})

describe('buildBatch', () => {
  const lines = (text: string): Array<{ lineNo: number; source: string; argv: string[] }> =>
    parseBatchScript(text).lines

  it('builds every step before anything is sent', () => {
    const r = buildBatch(lines('tabs\nexec document.title'), env)
    expect(r.steps.map((s: { request: { command: string } }) => s.request.command)).toEqual([
      'list-tabs',
      'exec-js'
    ])
  })

  it('fails the whole batch on one bad line, naming line and source', () => {
    const r = buildBatch(lines('tabs\nclick --nth 0 --text Go'), env)
    expect(r.error).toMatch(/^line 2: /)
    expect(r.error).toContain('click --nth 0 --text Go')
  })
})

describe('formatBatchResults', () => {
  it('reports each line, its failure, and a count', () => {
    const out = formatBatchResults([
      { lineNo: 1, source: 'tabs', response: { ok: true } },
      { lineNo: 2, source: 'click --text Go', response: { ok: false, error: 'no match' } },
      { lineNo: 3, source: 'exec 1', skipped: true }
    ])
    expect(out.split('\n')).toEqual([
      ' 1  ok    tabs',
      ' 2  FAIL  click --text Go  → no match',
      ' 3  skip  exec 1',
      '1 ok, 1 failed, 1 skipped'
    ])
  })
})

describe('buildWait', () => {
  it('builds one condition, with the tab and a timeout', () => {
    expect(buildWait('t1', { selector: '[role=dialog]', timeout: '2000' })).toEqual({
      request: {
        command: 'wait-for',
        params: { selector: '[role=dialog]', timeoutMs: 2000, tabId: 't1' }
      }
    })
  })

  it('carries --gone', () => {
    expect(buildWait(null, { selector: '.spinner', gone: true }).request.params).toEqual({
      selector: '.spinner',
      gone: true
    })
  })

  it('refuses zero conditions, and refuses two', () => {
    expect(buildWait(null, {}).error).toMatch(/--selector, --text or --url/)
    expect(buildWait(null, { selector: 'a', text: 'b' }).error).toMatch(/--selector and --text/)
  })

  it('refuses a junk timeout instead of silently using the default', () => {
    expect(buildWait(null, { selector: 'a', timeout: 'soon' }).error).toMatch(/number of ms/)
  })
})

describe('buildClick', () => {
  it('builds a selector click', () => {
    expect(buildClick('t1', { selector: 'button.go' })).toEqual({
      request: { command: 'click', params: { selector: 'button.go', tabId: 't1' } }
    })
  })

  it('parses --at into viewport coordinates', () => {
    expect(buildClick(null, { at: '320, 180' }).request.params).toEqual({ x: 320, y: 180 })
    expect(buildClick(null, { at: '320' }).error).toMatch(/viewport coordinates/)
  })

  it('carries --nth and --scroll', () => {
    const p = buildClick(null, { text: 'Settings', nth: '2', scroll: true }).request.params
    expect(p).toEqual({ text: 'Settings', nth: 2, scroll: true })
  })

  it('refuses no target, two targets, and a zero nth', () => {
    expect(buildClick(null, {}).error).toMatch(/--selector, --text or --at/)
    expect(buildClick(null, { selector: 'a', at: '1,2' }).error).toMatch(/one target/)
    expect(buildClick(null, { text: 'a', nth: '0' }).error).toMatch(/positive integer/)
  })
})
