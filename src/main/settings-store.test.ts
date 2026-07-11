import { describe, it, expect } from 'vitest'
import {
  defaultSettings,
  defaultLlm,
  normalizeSettings,
  normalizeLlm,
  clampWidth,
  withHomeUrl,
  withLlm,
  withSidebarWidth,
  withSkillPaneWidth,
  SIDEBAR_WIDTH,
  SKILL_PANE_WIDTH,
  DEFAULT_HOME_URL
} from './settings-store'

describe('normalizeSettings', () => {
  it('keeps a valid homeUrl and defaults the rest', () => {
    expect(normalizeSettings({ homeUrl: 'https://example.com' })).toEqual({
      ...defaultSettings(),
      homeUrl: 'https://example.com'
    })
  })

  it('trims a valid homeUrl', () => {
    expect(normalizeSettings({ homeUrl: '  https://example.com  ' })).toEqual({
      ...defaultSettings(),
      homeUrl: 'https://example.com'
    })
  })

  it('falls back to the default on a missing / non-string homeUrl', () => {
    expect(normalizeSettings({})).toEqual(defaultSettings())
    expect(normalizeSettings({ homeUrl: 42 })).toEqual(defaultSettings())
  })

  it('keeps an explicit empty homeUrl (user cleared it → blank new tabs)', () => {
    expect(normalizeSettings({ homeUrl: '' })).toEqual({ ...defaultSettings(), homeUrl: '' })
  })

  it('reads a persisted LLM config and clamps persisted widths', () => {
    expect(
      normalizeSettings({
        homeUrl: '',
        llm: { provider: 'anthropic-api', apiKey: 'k' },
        sidebarWidth: 300,
        skillPaneWidth: 99999
      })
    ).toEqual({
      homeUrl: '',
      llm: { provider: 'anthropic-api', apiKey: 'k' },
      sidebarWidth: 300,
      skillPaneWidth: SKILL_PANE_WIDTH.max
    })
  })

  it('degrades a bad/missing file to defaults', () => {
    expect(normalizeSettings(null)).toEqual(defaultSettings())
    expect(normalizeSettings('nope')).toEqual(defaultSettings())
    expect(normalizeSettings(undefined)).toEqual(defaultSettings())
  })
})

describe('normalizeLlm', () => {
  it('defaults an absent / unknown provider to the subscription CLI', () => {
    expect(normalizeLlm(undefined)).toEqual({ provider: 'claude-cli' })
    expect(normalizeLlm({ provider: 'nope' })).toEqual({ provider: 'claude-cli' })
  })

  it('keeps a valid provider and trims key/model, dropping empties', () => {
    expect(normalizeLlm({ provider: 'anthropic-api', apiKey: '  k  ', model: ' m ' })).toEqual({
      provider: 'anthropic-api',
      apiKey: 'k',
      model: 'm'
    })
    expect(normalizeLlm({ provider: 'anthropic-api', apiKey: '   ' })).toEqual({
      provider: 'anthropic-api'
    })
  })

  it('keeps loadMcp only when it is a real boolean', () => {
    expect(normalizeLlm({ provider: 'claude-cli', loadMcp: true })).toEqual({
      provider: 'claude-cli',
      loadMcp: true
    })
    expect(normalizeLlm({ provider: 'claude-cli', loadMcp: false })).toEqual({
      provider: 'claude-cli',
      loadMcp: false
    })
    // A non-boolean (e.g. a corrupt file) is dropped, not coerced.
    expect(normalizeLlm({ provider: 'claude-cli', loadMcp: 'yes' })).toEqual({
      provider: 'claude-cli'
    })
  })
})

describe('clampWidth', () => {
  it('clamps into the range and rounds', () => {
    expect(clampWidth(10, SIDEBAR_WIDTH)).toBe(SIDEBAR_WIDTH.min)
    expect(clampWidth(9999, SIDEBAR_WIDTH)).toBe(SIDEBAR_WIDTH.max)
    expect(clampWidth(300.6, SIDEBAR_WIDTH)).toBe(301)
  })

  it('falls back to the default on a non-finite value', () => {
    expect(clampWidth('nope', SIDEBAR_WIDTH)).toBe(SIDEBAR_WIDTH.default)
    expect(clampWidth(NaN, SIDEBAR_WIDTH)).toBe(SIDEBAR_WIDTH.default)
  })
})

describe('withHomeUrl', () => {
  it('sets a trimmed home url, preserving the rest', () => {
    expect(withHomeUrl(defaultSettings(), '  https://b.com ')).toEqual({
      ...defaultSettings(),
      homeUrl: 'https://b.com'
    })
  })

  it('allows an empty value (clears the home → blank new tabs)', () => {
    expect(withHomeUrl(defaultSettings(), '   ')).toEqual({ ...defaultSettings(), homeUrl: '' })
  })
})

describe('withLlm', () => {
  it('replaces the LLM config (normalized), preserving the rest', () => {
    expect(withLlm(defaultSettings(), { provider: 'anthropic-api', apiKey: 'k' })).toEqual({
      ...defaultSettings(),
      llm: { provider: 'anthropic-api', apiKey: 'k' }
    })
  })
})

describe('withSidebarWidth / withSkillPaneWidth', () => {
  it('sets clamped panel widths, preserving the rest', () => {
    expect(withSidebarWidth(defaultSettings(), 5)).toEqual({
      ...defaultSettings(),
      sidebarWidth: SIDEBAR_WIDTH.min
    })
    expect(withSkillPaneWidth(defaultSettings(), 400)).toEqual({
      ...defaultSettings(),
      skillPaneWidth: 400
    })
  })
})

describe('DEFAULT_HOME_URL', () => {
  it('is the built-in home', () => {
    expect(defaultSettings().homeUrl).toBe(DEFAULT_HOME_URL)
    expect(defaultLlm()).toEqual({ provider: 'claude-cli' })
  })
})
