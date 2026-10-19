import { describe, it, expect } from 'vitest'
import {
  terminalModeOn,
  shellQuote,
  buildClaudeLaunch,
  skillTerminalPrompt,
  terminalShown,
  parseTerminalRect,
  terminalText,
  firstMessage,
  localeEnv,
  TERMINAL_SYSTEM_PROMPT
} from './kova-pane'

describe('terminalModeOn', () => {
  it('is on only with the addon AND the claude-cli provider', () => {
    expect(terminalModeOn({ addonAvailable: true, provider: 'claude-cli' })).toBe(true)
    expect(terminalModeOn({ addonAvailable: false, provider: 'claude-cli' })).toBe(false)
    expect(terminalModeOn({ addonAvailable: true, provider: 'anthropic-api' })).toBe(false)
    expect(terminalModeOn({ addonAvailable: true, provider: 'extractive' })).toBe(false)
  })
})

describe('shellQuote', () => {
  it('wraps in single quotes and escapes embedded ones', () => {
    expect(shellQuote('abc')).toBe("'abc'")
    expect(shellQuote("it's")).toBe("'it'\\''s'")
    expect(shellQuote('$HOME `x` "y"')).toBe('\'$HOME `x` "y"\'')
  })
})

describe('buildClaudeLaunch', () => {
  it('execs claude with the system prompt and opts out of the session window', () => {
    const { command, env } = buildClaudeLaunch(undefined, { LANG: 'C.UTF-8' })
    expect(command).toBe(
      'unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID; ' +
        `exec claude --append-system-prompt ${shellQuote(TERMINAL_SYSTEM_PROMPT)} || exit`
    )
    expect(env).toEqual(['MIRA_NO_SESSION_WINDOW=1'])
  })

  it('passes an initial prompt as one quoted, single-line word', () => {
    const { command } = buildClaudeLaunch("Summarize\nthis  page's text")
    expect(command.endsWith(` ${shellQuote("Summarize this page's text")} || exit`)).toBe(true)
    expect(command).not.toContain('\n')
  })

  it('ignores an empty initial prompt', () => {
    expect(buildClaudeLaunch('  \n ').command).toBe(buildClaudeLaunch().command)
  })

  it('never contains a control character (the shell line editor would act on it)', () => {
    // Ctrl+U kills the line, Ctrl+O accepts it, ESC starts a sequence, \n runs it.
    const { command } = buildClaudeLaunch('a\nb\u0015c\u000fd\u001b[2Je\u009bf\u007fg')
    // eslint-disable-next-line no-control-regex
    expect(command).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
    expect(command.endsWith(` ${shellQuote('a b c d [2Je f g')} || exit`)).toBe(true)
  })
})

describe('skillTerminalPrompt', () => {
  it('is the skill name and prompt on one line, asking to read the page', () => {
    const text = skillTerminalPrompt({ name: 'Summarize this page', prompt: 'Summarize\nit.' })
    expect(text).toBe(
      'Summarize this page: Summarize it. Read the current page with the mira CLI first.'
    )
  })
})

describe('terminalShown', () => {
  const rect = { x: 900, y: 90, width: 354, height: 600 }
  const base = { paneOpen: true, paletteOpen: false, mediaGalleryOpen: false, rect }

  it('shows when the pane is open with a measured rect', () => {
    expect(terminalShown(base)).toBe(true)
  })

  it('hides when the pane is closed or not measured yet', () => {
    expect(terminalShown({ ...base, paneOpen: false })).toBe(false)
    expect(terminalShown({ ...base, rect: null })).toBe(false)
    expect(terminalShown({ ...base, rect: { ...rect, width: 0 } })).toBe(false)
  })

  it('hides under the full-window DOM overlays', () => {
    expect(terminalShown({ ...base, paletteOpen: true })).toBe(false)
    expect(terminalShown({ ...base, mediaGalleryOpen: true })).toBe(false)
  })
})

describe('parseTerminalRect', () => {
  it('accepts a finite non-negative rect and null', () => {
    expect(parseTerminalRect({ x: 1, y: 2, width: 3, height: 4 })).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4
    })
    expect(parseTerminalRect(null)).toBeNull()
  })

  it('rejects malformed input', () => {
    expect(parseTerminalRect(undefined)).toBeUndefined()
    expect(parseTerminalRect({ x: 1, y: 2, width: 3 })).toBeUndefined()
    expect(parseTerminalRect({ x: 1, y: 2, width: -3, height: 4 })).toBeUndefined()
    expect(parseTerminalRect({ x: NaN, y: 2, width: 3, height: 4 })).toBeUndefined()
    expect(parseTerminalRect('rect')).toBeUndefined()
  })
})

describe('terminalText', () => {
  it('keeps printable text and collapses whitespace', () => {
    expect(terminalText('  What  is\tthis\n page?  ')).toBe('What is this page?')
    expect(terminalText('Résumé — 1. ok')).toBe('Résumé — 1. ok')
  })

  it('turns every C0, DEL and C1 control character into a space', () => {
    expect(terminalText('a\rb\u0003c\u001bd\u007fe\u0085f')).toBe('a b c d e f')
  })
})

describe('firstMessage', () => {
  it('prefixes a message that would start like an option or a command', () => {
    expect(firstMessage('--dangerously-skip-permissions')).toBe(
      'Prompt: --dangerously-skip-permissions'
    )
    expect(firstMessage('/clear')).toBe('Prompt: /clear')
    expect(firstMessage('!rm -rf ~')).toBe('Prompt: !rm -rf ~')
    expect(firstMessage('# remember')).toBe('Prompt: # remember')
  })

  it('leaves an ordinary message alone, after terminalText', () => {
    expect(firstMessage('  What is\nthis?')).toBe('What is this?')
  })

  it('is what buildClaudeLaunch passes to claude', () => {
    expect(buildClaudeLaunch('-p hi').command).toContain(` ${shellQuote('Prompt: -p hi')} || exit`)
  })
})

describe('localeEnv', () => {
  it('gives a UTF-8 locale only when the host has none', () => {
    expect(localeEnv({})).toEqual(['LANG=en_US.UTF-8'])
    expect(localeEnv({ LANG: ' ' })).toEqual(['LANG=en_US.UTF-8'])
    expect(localeEnv({ LANG: 'fr_FR.UTF-8' })).toEqual([])
    expect(localeEnv({ LC_ALL: 'C.UTF-8' })).toEqual([])
    expect(localeEnv({ LC_CTYPE: 'UTF-8' })).toEqual([])
  })

  it('reaches the pane env through buildClaudeLaunch', () => {
    expect(buildClaudeLaunch(undefined, {}).env).toEqual([
      'MIRA_NO_SESSION_WINDOW=1',
      'LANG=en_US.UTF-8'
    ])
    expect(buildClaudeLaunch(undefined, { LANG: 'C.UTF-8' }).env).toEqual([
      'MIRA_NO_SESSION_WINDOW=1'
    ])
  })
})
