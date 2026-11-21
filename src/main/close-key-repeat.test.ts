import { describe, expect, it } from 'vitest'
import {
  CLOSE_REPEAT_GUARD_MS,
  CloseKeyRepeatGuard,
  isRepeatedCloseKey,
  type CloseKeyInput
} from './close-key-repeat'

const key = (over: Partial<CloseKeyInput>): CloseKeyInput => ({
  type: 'keyDown',
  key: 'w',
  isAutoRepeat: true,
  meta: true,
  control: false,
  ...over
})

describe('isRepeatedCloseKey', () => {
  it('drops a repeated Cmd+W on macOS', () => {
    expect(isRepeatedCloseKey(key({}), 'darwin')).toBe(true)
  })
  it('drops a repeated Cmd+Shift+W (key reported uppercase)', () => {
    expect(isRepeatedCloseKey(key({ key: 'W' }), 'darwin')).toBe(true)
  })
  it('lets the first press through', () => {
    expect(isRepeatedCloseKey(key({ isAutoRepeat: false }), 'darwin')).toBe(false)
  })
  it('lets a held plain w repeat (typing)', () => {
    expect(isRepeatedCloseKey(key({ meta: false }), 'darwin')).toBe(false)
  })
  it('lets Cmd+Z repeat (undo), whatever the physical key', () => {
    expect(isRepeatedCloseKey(key({ key: 'z' }), 'darwin')).toBe(false)
  })
  it('ignores keyUp', () => {
    expect(isRepeatedCloseKey(key({ type: 'keyUp' }), 'darwin')).toBe(false)
  })
  it('uses Ctrl off macOS', () => {
    expect(isRepeatedCloseKey(key({ meta: false, control: true }), 'linux')).toBe(true)
    expect(isRepeatedCloseKey(key({}), 'linux')).toBe(false)
  })
})

describe('CloseKeyRepeatGuard', () => {
  it('holds nothing before any repeat', () => {
    expect(new CloseKeyRepeatGuard().isHeld(1000)).toBe(false)
  })
  it('skips a menu close right after a blocked repeat, not later', () => {
    const g = new CloseKeyRepeatGuard()
    g.noteRepeat(1000)
    expect(g.isHeld(1000 + 50)).toBe(true)
    expect(g.isHeld(1000 + CLOSE_REPEAT_GUARD_MS)).toBe(false)
  })
})
