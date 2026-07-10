import { describe, it, expect } from 'vitest'
import { decideWindowOpen } from './window-open'

describe('decideWindowOpen', () => {
  it('routes a popup (new-window) to a real child window — OAuth/SSO opener survives', () => {
    expect(
      decideWindowOpen({
        url: 'https://accounts.google.com/o/oauth2/...',
        disposition: 'new-window'
      })
    ).toEqual({
      kind: 'popup'
    })
  })

  it('also treats new-popup as a popup', () => {
    expect(
      decideWindowOpen({ url: 'https://login.microsoftonline.com', disposition: 'new-popup' })
    ).toEqual({
      kind: 'popup'
    })
  })

  it('opens a foreground-tab (target=_blank) as a Mira tab', () => {
    expect(
      decideWindowOpen({ url: 'https://example.com/page', disposition: 'foreground-tab' })
    ).toEqual({ kind: 'tab', url: 'https://example.com/page' })
  })

  it('opens a background-tab (Cmd+click) as a Mira tab', () => {
    expect(
      decideWindowOpen({ url: 'https://example.com/bg', disposition: 'background-tab' })
    ).toEqual({ kind: 'tab', url: 'https://example.com/bg' })
  })

  it('defaults an unknown/absent disposition to a tab', () => {
    expect(decideWindowOpen({ url: 'https://example.com' })).toEqual({
      kind: 'tab',
      url: 'https://example.com'
    })
  })
})
