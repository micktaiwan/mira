import { describe, it, expect } from 'vitest'
import {
  commandsFromManifest,
  inputMatches,
  isExecuteActionCommand,
  parseCommandShortcut,
  type InputLike
} from './extension-commands'

const keyDown = (overrides: Partial<InputLike>): InputLike => ({
  type: 'keyDown',
  key: '',
  control: false,
  meta: false,
  shift: false,
  alt: false,
  ...overrides
})

describe('parseCommandShortcut', () => {
  it('parses the Claap shortcut (Command+Shift+S on mac)', () => {
    expect(parseCommandShortcut('Command+Shift+S', 'darwin')).toEqual({
      key: 'S',
      meta: true,
      ctrl: false,
      shift: true,
      alt: false
    })
  })

  it("converts Ctrl to Command on mac (Chrome's documented behavior), keeps it elsewhere", () => {
    expect(parseCommandShortcut('Ctrl+Shift+S', 'darwin')).toMatchObject({
      meta: true,
      ctrl: false
    })
    expect(parseCommandShortcut('Ctrl+Shift+S', 'linux')).toMatchObject({ meta: false, ctrl: true })
    // MacCtrl means the real Control key on mac.
    expect(parseCommandShortcut('MacCtrl+S', 'darwin')).toMatchObject({ meta: false, ctrl: true })
  })

  it('maps named keys and function keys', () => {
    expect(parseCommandShortcut('Alt+Comma', 'darwin')).toMatchObject({ key: ',', alt: true })
    expect(parseCommandShortcut('Command+Up', 'darwin')).toMatchObject({ key: 'ArrowUp' })
    expect(parseCommandShortcut('F5', 'darwin')).toMatchObject({ key: 'F5' })
  })

  it('rejects media keys, Search, double keys and unknown tokens', () => {
    expect(parseCommandShortcut('MediaPlayPause', 'darwin')).toBeNull()
    expect(parseCommandShortcut('Search+S', 'linux')).toBeNull()
    expect(parseCommandShortcut('Command+S+D', 'darwin')).toBeNull()
    expect(parseCommandShortcut('Command+Bogus', 'darwin')).toBeNull()
    expect(parseCommandShortcut('Command+Shift', 'darwin')).toBeNull()
  })
})

describe('commandsFromManifest', () => {
  const claapManifest = {
    commands: {
      _execute_action: {
        suggested_key: { default: 'Ctrl+Shift+S', mac: 'Command+Shift+S' }
      }
    }
  }

  it('prefers the platform key and falls back to default', () => {
    const onMac = commandsFromManifest(claapManifest, 'darwin')
    expect(onMac).toEqual([
      {
        name: '_execute_action',
        shortcut: { key: 'S', meta: true, ctrl: false, shift: true, alt: false }
      }
    ])
    const onLinux = commandsFromManifest(claapManifest, 'linux')
    expect(onLinux[0].shortcut).toMatchObject({ ctrl: true, meta: false })
  })

  it('skips commands without a usable shortcut, and tolerates junk', () => {
    expect(commandsFromManifest({ commands: { noop: { description: 'x' } } }, 'darwin')).toEqual([])
    expect(commandsFromManifest({}, 'darwin')).toEqual([])
    expect(commandsFromManifest(null, 'darwin')).toEqual([])
  })
})

describe('inputMatches', () => {
  const claap = { key: 'S', meta: true, ctrl: false, shift: true, alt: false }

  it('matches the exact chord, including Shift-produced uppercase', () => {
    expect(inputMatches(claap, keyDown({ key: 'S', meta: true, shift: true }))).toBe(true)
    expect(inputMatches(claap, keyDown({ key: 's', meta: true, shift: true }))).toBe(true)
  })

  it('requires modifiers to match exactly and ignores keyUp', () => {
    expect(inputMatches(claap, keyDown({ key: 'S', meta: true }))).toBe(false)
    expect(inputMatches(claap, keyDown({ key: 'S', meta: true, shift: true, alt: true }))).toBe(
      false
    )
    expect(
      inputMatches(claap, { ...keyDown({ key: 'S', meta: true, shift: true }), type: 'keyUp' })
    ).toBe(false)
  })
})

describe('isExecuteActionCommand', () => {
  it('recognizes all _execute variants and nothing else', () => {
    expect(isExecuteActionCommand('_execute_action')).toBe(true)
    expect(isExecuteActionCommand('_execute_browser_action')).toBe(true)
    expect(isExecuteActionCommand('toggle-recording')).toBe(false)
  })
})
