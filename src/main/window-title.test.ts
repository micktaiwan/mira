import { describe, it, expect } from 'vitest'
import { windowTitle, APP_NAME } from './window-title'

describe('windowTitle', () => {
  it('names a window after its profile, so macOS can tell two windows apart', () => {
    expect(windowTitle('Perso')).toBe('Mira — Perso')
    expect(windowTitle('Claude Test')).toBe('Mira — Claude Test')
  })

  it('trims the label rather than baking the padding into the title', () => {
    expect(windowTitle('  Pro  ')).toBe('Mira — Pro')
  })

  it('degrades to the bare app name instead of a dangling separator', () => {
    expect(windowTitle('')).toBe(APP_NAME)
    expect(windowTitle('   ')).toBe(APP_NAME)
    expect(windowTitle(null)).toBe(APP_NAME)
    expect(windowTitle(undefined)).toBe(APP_NAME)
  })
})
