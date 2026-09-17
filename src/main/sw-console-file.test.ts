import { describe, expect, it } from 'vitest'
import {
  SW_CONSOLE_FILE_LIMIT,
  serializeSwConsole,
  shouldCompactSwConsole
} from './sw-console-file'

describe('shouldCompactSwConsole', () => {
  it('leaves a small mirror alone', () => {
    expect(shouldCompactSwConsole(0)).toBe(false)
    expect(shouldCompactSwConsole(SW_CONSOLE_FILE_LIMIT - 1)).toBe(false)
  })

  it('compacts once the limit is reached', () => {
    expect(shouldCompactSwConsole(SW_CONSOLE_FILE_LIMIT)).toBe(true)
    expect(shouldCompactSwConsole(SW_CONSOLE_FILE_LIMIT + 1)).toBe(true)
  })

  it('honours an explicit limit', () => {
    expect(shouldCompactSwConsole(5, 10)).toBe(false)
    expect(shouldCompactSwConsole(10, 10)).toBe(true)
  })
})

describe('serializeSwConsole', () => {
  it('writes one JSON object per line, newline-terminated', () => {
    expect(serializeSwConsole([{ seq: 1 }, { seq: 2 }])).toBe('{"seq":1}\n{"seq":2}\n')
  })

  it('writes nothing for an empty buffer', () => {
    expect(serializeSwConsole([])).toBe('')
  })
})
