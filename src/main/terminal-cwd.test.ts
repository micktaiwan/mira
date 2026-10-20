import { describe, it, expect } from 'vitest'
import { normalizeTerminalCwd, parseTerminalCwdInput, resolveTerminalCwd } from './terminal-cwd'

const HOME = '/Users/me'

describe('normalizeTerminalCwd', () => {
  it('keeps an absolute folder, without trailing slashes', () => {
    expect(normalizeTerminalCwd('/Users/me/projects/notes/', HOME)).toBe('/Users/me/projects/notes')
    expect(normalizeTerminalCwd('  /tmp  ', HOME)).toBe('/tmp')
    expect(normalizeTerminalCwd('/', HOME)).toBe('/')
  })

  it('expands a leading ~', () => {
    expect(normalizeTerminalCwd('~', HOME)).toBe(HOME)
    expect(normalizeTerminalCwd('~/projects/notes', HOME)).toBe('/Users/me/projects/notes')
  })

  it('reads empty or null as "clear"', () => {
    expect(normalizeTerminalCwd('', HOME)).toBeNull()
    expect(normalizeTerminalCwd('   ', HOME)).toBeNull()
    expect(normalizeTerminalCwd(null, HOME)).toBeNull()
  })

  it('rejects a relative folder, ~user included', () => {
    expect(() => normalizeTerminalCwd('projects/notes', HOME)).toThrow('not an absolute folder')
    expect(() => normalizeTerminalCwd('~bob/x', HOME)).toThrow('not an absolute folder')
  })
})

describe('parseTerminalCwdInput', () => {
  const isDir = (p: string): boolean => p === '/Users/me/projects/notes'

  it('returns the normalized folder when it exists', () => {
    expect(parseTerminalCwdInput('~/projects/notes/', HOME, isDir)).toBe('/Users/me/projects/notes')
  })

  it('refuses a folder that does not exist, and passes "clear" through', () => {
    expect(() => parseTerminalCwdInput('~/projects/noteso', HOME, isDir)).toThrow(
      'no such folder: /Users/me/projects/noteso'
    )
    expect(parseTerminalCwdInput('', HOME, isDir)).toBeNull()
  })
})

describe('resolveTerminalCwd', () => {
  const dirs = new Set(['/Users/me/projects/notes'])
  const isDir = (p: string): boolean => dirs.has(p)

  it('uses the profile folder when it is a directory', () => {
    expect(resolveTerminalCwd('/Users/me/projects/notes', HOME, isDir)).toBe('/Users/me/projects/notes')
  })

  it('falls back to home when unset or gone', () => {
    expect(resolveTerminalCwd(undefined, HOME, isDir)).toBe(HOME)
    expect(resolveTerminalCwd('/Users/me/gone', HOME, isDir)).toBe(HOME)
  })
})
