import { describe, it, expect } from 'vitest'
import { loginPromptSize, renderLoginPromptHtml } from './login-prompt'

describe('renderLoginPromptHtml', () => {
  it('names the account and the vault, and asks to save', () => {
    const html = renderLoginPromptHtml({
      mode: 'save',
      loginLabel: 'me@example.com on banco.mickaelfm.me',
      account: 'faivrem@gmail.com'
    })
    expect(html).toContain('Save this login to Bitwarden?')
    expect(html).toContain('me@example.com on banco.mickaelfm.me')
    expect(html).toContain('faivrem@gmail.com')
    expect(html).toContain('>Save<')
    expect(html).not.toContain('type="password"')
  })

  it('asks for the master password when the vault is locked', () => {
    const html = renderLoginPromptHtml({
      mode: 'unlock',
      loginLabel: 'me@example.com on banco.mickaelfm.me',
      account: 'faivrem@gmail.com'
    })
    expect(html).toContain('Master password')
    expect(html).toContain('Unlock and save')
  })

  it('says so when the vault already holds another password for that account', () => {
    const html = renderLoginPromptHtml({
      mode: 'update',
      loginLabel: 'me@example.com on banco.mickaelfm.me',
      account: 'faivrem@gmail.com'
    })
    expect(html).toContain('Update this login in Bitwarden?')
    expect(html).toContain('The vault holds another password for it.')
    expect(html).toContain('Updating the login…')
  })

  it('escapes what came from a page', () => {
    const html = renderLoginPromptHtml({
      mode: 'save',
      loginLabel: '<img src=x onerror=alert(1)> on evil.example',
      account: 'faivrem@gmail.com'
    })
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('shows a previous failure above the buttons', () => {
    const html = renderLoginPromptHtml({
      mode: 'unlock',
      loginLabel: 'me@example.com on x.com',
      account: 'faivrem@gmail.com',
      error: 'Could not unlock the vault. Try again.'
    })
    expect(html).toContain('Could not unlock the vault. Try again.')
  })
})

describe('loginPromptSize', () => {
  it('is taller when it has a password field to show', () => {
    expect(loginPromptSize('unlock').height).toBeGreaterThan(loginPromptSize('save').height)
    expect(loginPromptSize('update')).toEqual(loginPromptSize('save'))
  })
})
