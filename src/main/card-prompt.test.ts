import { describe, it, expect } from 'vitest'
import {
  busyScript,
  escapeHtml,
  parsePromptAnswer,
  promptBounds,
  promptSize,
  renderCardPromptHtml
} from './card-prompt'

describe('parsePromptAnswer', () => {
  it('reads a save', () => {
    expect(parsePromptAnswer('{"action":"save"}')).toEqual({ action: 'save' })
  })

  it('reads an unlock with its password', () => {
    expect(parsePromptAnswer('{"action":"unlock","password":"hunter2"}')).toEqual({
      action: 'unlock',
      password: 'hunter2'
    })
  })

  it('treats anything unexpected as "not now"', () => {
    expect(parsePromptAnswer('')).toBeNull()
    expect(parsePromptAnswer('null')).toBeNull()
    expect(parsePromptAnswer('{oops')).toBeNull()
    expect(parsePromptAnswer('{"action":"delete-everything"}')).toBeNull()
    expect(parsePromptAnswer('{"action":"unlock","password":""}')).toBeNull()
    expect(parsePromptAnswer(42)).toBeNull()
  })
})

describe('renderCardPromptHtml', () => {
  const base = {
    mode: 'save' as const,
    cardLabel: 'Visa 4242',
    host: 'shop.example.com',
    account: 'faivrem@gmail.com'
  }

  it('shows the card, the site and the target vault', () => {
    const html = renderCardPromptHtml(base)
    expect(html).toContain('Visa 4242')
    expect(html).toContain('shop.example.com')
    expect(html).toContain('faivrem@gmail.com')
  })

  it('asks for the master password only in unlock mode', () => {
    expect(renderCardPromptHtml(base)).not.toContain('type="password"')
    const unlock = renderCardPromptHtml({ ...base, mode: 'unlock' })
    expect(unlock).toContain('type="password"')
    expect(unlock).toContain('Unlock and save')
  })

  it('shows a previous failure', () => {
    expect(renderCardPromptHtml({ ...base, error: 'Invalid master password' })).toContain(
      'Invalid master password'
    )
  })

  it('escapes a hostile host instead of injecting markup', () => {
    const html = renderCardPromptHtml({ ...base, host: '<img src=x onerror=alert(1)>' })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img')
  })
})

describe('escapeHtml', () => {
  it('escapes the five dangerous characters', () => {
    expect(escapeHtml(`<&">'`)).toBe('&lt;&amp;&quot;&gt;&#39;')
  })
})

describe('promptBounds', () => {
  const win = { x: 100, y: 50, width: 1000, height: 700 }

  it('anchors the bubble under the toolbar, at the right edge', () => {
    const size = promptSize('save')
    expect(promptBounds(win, size)).toEqual({
      x: 100 + 1000 - size.width - 8,
      y: 50 + 40,
      width: size.width,
      height: size.height
    })
  })

  it('never places the bubble left of the window', () => {
    expect(promptBounds({ x: 0, y: 0, width: 200, height: 400 }, promptSize('save')).x).toBe(0)
  })

  it('makes room for the password field in unlock mode', () => {
    expect(promptSize('unlock').height).toBeGreaterThan(promptSize('save').height)
  })
})

describe('busyScript', () => {
  it('calls the page hook with the label', () => {
    expect(busyScript('Saving the card…')).toBe(
      'window.miraCardBusy && window.miraCardBusy("Saving the card…")'
    )
  })

  it('escapes a label safely', () => {
    expect(busyScript('a"b')).toContain('"a\\"b"')
  })
})

describe('the bubble page', () => {
  const base = {
    mode: 'unlock' as const,
    cardLabel: 'Visa 4242',
    host: 'shop.example.com',
    account: 'faivrem@gmail.com'
  }

  it('carries a progress line and the hook main drives', () => {
    const html = renderCardPromptHtml(base)
    expect(html).toContain('id="busy"')
    expect(html).toContain('window.miraCardBusy')
  })

  it('shows progress from the click itself, before main answers', () => {
    expect(renderCardPromptHtml(base)).toContain('Unlocking the vault…')
  })
})

describe('unlock-vault mode (reading the cards back)', () => {
  const req = {
    mode: 'unlock-vault' as const,
    cardLabel: '',
    host: '',
    account: 'faivrem@gmail.com'
  }

  it('asks about the vault, not about a card', () => {
    const html = renderCardPromptHtml(req)
    expect(html).toContain('Unlock the Bitwarden vault?')
    expect(html).not.toContain('Save this card')
    expect(html).toContain('type="password"')
    expect(html).toContain('>Unlock<')
  })

  it('leaves room for the password field', () => {
    expect(promptSize('unlock-vault').height).toBeGreaterThan(promptSize('save').height)
  })
})
