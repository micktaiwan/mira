import { describe, it, expect } from 'vitest'
import { buildPageMenu, type PageContext } from './page-menu'

const base: PageContext = {
  linkURL: '',
  selectionText: '',
  isEditable: false,
  canGoBack: false,
  canGoForward: false
}

describe('buildPageMenu', () => {
  it('always offers back / forward / reload, with history-driven enabled flags', () => {
    const items = buildPageMenu({ ...base, canGoBack: true, canGoForward: false })
    expect(items).toEqual([
      { type: 'command', command: 'back', label: 'Back', enabled: true },
      { type: 'command', command: 'forward', label: 'Forward', enabled: false },
      { type: 'command', command: 'reload', label: 'Reload', enabled: true }
    ])
  })

  it('adds an "open link in new tab" command when on a link', () => {
    const items = buildPageMenu({ ...base, linkURL: 'https://example.com' })
    expect(items).toContainEqual({
      type: 'command',
      command: 'new-tab',
      params: { url: 'https://example.com' },
      label: 'Open Link in New Tab',
      enabled: true
    })
  })

  it('offers the full clipboard set in an editable field', () => {
    const items = buildPageMenu({ ...base, isEditable: true })
    const roles = items.filter((i) => i.type === 'role').map((i) => i.type === 'role' && i.role)
    expect(roles).toEqual(['cut', 'copy', 'paste', 'selectAll'])
  })

  it('offers only Copy over a plain text selection (not editable)', () => {
    const items = buildPageMenu({ ...base, selectionText: 'hello' })
    const roles = items.filter((i) => i.type === 'role').map((i) => i.type === 'role' && i.role)
    expect(roles).toEqual(['copy'])
  })

  it('shows no clipboard items when there is neither a selection nor an editable field', () => {
    const items = buildPageMenu(base)
    expect(items.some((i) => i.type === 'role')).toBe(false)
    expect(items.some((i) => i.type === 'separator')).toBe(false)
  })
})
