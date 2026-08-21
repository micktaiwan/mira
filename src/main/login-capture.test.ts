import { describe, it, expect } from 'vitest'
import {
  classifyLoginField,
  collectLogin,
  draftComplete,
  loginFingerprint,
  loginItemName,
  loginLabel,
  mergeLoginFragment,
  normalizeLoginFragment,
  validateLogin,
  EMPTY_LOGIN_DRAFT,
  LOGIN_DRAFT_TTL_MS,
  type LoginDraft,
  type LoginFragment
} from './login-capture'

const fragment = (over: Partial<LoginFragment> = {}): LoginFragment => ({
  username: '',
  password: '',
  kind: 'current',
  hasUsernameField: false,
  submitted: false,
  url: 'https://banco.mickaelfm.me/login',
  ...over
})

const draft = (over: Partial<LoginDraft> = {}): LoginDraft => ({
  ...EMPTY_LOGIN_DRAFT,
  url: 'https://banco.mickaelfm.me/login',
  ...over
})

describe('classifyLoginField', () => {
  it('reads the autocomplete attribute when the site sets one', () => {
    expect(classifyLoginField({ type: 'password', autocomplete: 'current-password' })).toBe(
      'password'
    )
    expect(classifyLoginField({ type: 'password', autocomplete: 'new-password' })).toBe(
      'new-password'
    )
    expect(classifyLoginField({ type: 'text', autocomplete: 'username' })).toBe('username')
    expect(classifyLoginField({ type: 'text', autocomplete: 'email' })).toBe('username')
  })

  it('falls back to the text around the field', () => {
    expect(classifyLoginField({ type: 'password', name: 'pwd' })).toBe('password')
    expect(classifyLoginField({ type: 'password', name: 'confirm_password' })).toBe('new-password')
    expect(classifyLoginField({ type: 'password', label: 'Nouveau mot de passe' })).toBe(
      'new-password'
    )
    expect(classifyLoginField({ type: 'text', name: 'identifiant' })).toBe('username')
    expect(classifyLoginField({ type: 'email' })).toBe('username')
  })

  it('leaves ordinary fields alone', () => {
    expect(classifyLoginField({ type: 'text', name: 'search' })).toBeNull()
    expect(classifyLoginField({ type: 'checkbox', name: 'remember-me' })).toBeNull()
    expect(classifyLoginField({ type: 'text' })).toBeNull()
  })
})

describe('collectLogin', () => {
  it('takes the one filled password and the filled username', () => {
    expect(
      collectLogin([
        { attrs: { type: 'text', name: 'email' }, value: 'me@example.com' },
        { attrs: { type: 'password', name: 'password' }, value: 'hunter22' }
      ])
    ).toEqual({
      username: 'me@example.com',
      password: 'hunter22',
      kind: 'current',
      hasUsernameField: true
    })
  })

  it('takes a signup password when the confirmation agrees', () => {
    const collected = collectLogin([
      { attrs: { type: 'email', name: 'email' }, value: 'me@example.com' },
      { attrs: { type: 'password', autocomplete: 'new-password' }, value: 'hunter22' },
      { attrs: { type: 'password', name: 'confirm' }, value: 'hunter22' }
    ])
    expect(collected.password).toBe('hunter22')
    expect(collected.kind).toBe('new')
  })

  it('reports NOTHING while the confirmation does not match', () => {
    const collected = collectLogin([
      { attrs: { type: 'password', autocomplete: 'new-password' }, value: 'hunter22' },
      { attrs: { type: 'password', name: 'confirm' }, value: 'hunt' }
    ])
    expect(collected.password).toBe('')
  })

  it('takes the NEW password of a change-password form, not the current one', () => {
    const collected = collectLogin([
      { attrs: { type: 'password', autocomplete: 'current-password' }, value: 'old-one' },
      { attrs: { type: 'password', autocomplete: 'new-password' }, value: 'brand-new' },
      { attrs: { type: 'password', name: 'confirm' }, value: 'brand-new' }
    ])
    expect(collected.password).toBe('brand-new')
    expect(collected.kind).toBe('new')
  })

  it('says when the form has no username box at all', () => {
    const collected = collectLogin([
      { attrs: { type: 'password', name: 'password' }, value: 'hunter22' }
    ])
    expect(collected.hasUsernameField).toBe(false)
    expect(collected.username).toBe('')
  })
})

describe('mergeLoginFragment', () => {
  it('carries the username of step 1 into the password page of step 2', () => {
    const first = mergeLoginFragment(
      undefined,
      fragment({ username: 'me@example.com', hasUsernameField: true }),
      1000
    )
    const second = mergeLoginFragment(
      first,
      fragment({ password: 'hunter22', hasUsernameField: false, submitted: true }),
      2000
    )
    expect(second.username).toBe('me@example.com')
    expect(second.password).toBe('hunter22')
    expect(draftComplete(second)).toBe(true)
  })

  it('drops a draft older than the TTL instead of pairing across sites', () => {
    const old = mergeLoginFragment(undefined, fragment({ username: 'me@example.com' }), 1000)
    const later = mergeLoginFragment(
      old,
      fragment({ password: 'hunter22' }),
      1000 + LOGIN_DRAFT_TTL_MS + 1
    )
    expect(later.username).toBe('')
  })

  it('never lets an empty half erase a known one', () => {
    const first = mergeLoginFragment(undefined, fragment({ password: 'hunter22' }), 1000)
    const second = mergeLoginFragment(first, fragment({ username: 'me@example.com' }), 1500)
    expect(second.password).toBe('hunter22')
  })
})

describe('draftComplete', () => {
  it('waits for the username when the form has a box for one', () => {
    expect(draftComplete(draft({ password: 'hunter22', usernameExpected: true }))).toBe(false)
    expect(
      draftComplete(draft({ password: 'hunter22', username: 'me', usernameExpected: true }))
    ).toBe(true)
  })

  it('is complete without a username when the form has no box for one', () => {
    expect(draftComplete(draft({ password: 'hunter22', usernameExpected: false }))).toBe(true)
  })

  it('is never complete without a password', () => {
    expect(draftComplete(draft({ username: 'me@example.com' }))).toBe(false)
  })
})

describe('validateLogin', () => {
  it('accepts a real pair and keeps the host and a clean url', () => {
    const login = validateLogin(
      draft({
        username: 'me@example.com',
        password: 'hunter22',
        url: 'https://banco.mickaelfm.me/login?token=abc'
      })
    )
    expect(login).toEqual({
      username: 'me@example.com',
      password: 'hunter22',
      host: 'banco.mickaelfm.me',
      url: 'https://banco.mickaelfm.me/login',
      isNew: false
    })
  })

  it('refuses a password too short to be one', () => {
    expect(validateLogin(draft({ password: 'ab' }))).toBeNull()
  })

  it('refuses anything that is not an http(s) page', () => {
    expect(validateLogin(draft({ password: 'hunter22', url: 'file:///tmp/form.html' }))).toBeNull()
    expect(validateLogin(draft({ password: 'hunter22', url: 'not-a-url' }))).toBeNull()
  })

  it('marks a signup password as new', () => {
    expect(validateLogin(draft({ password: 'hunter22', kind: 'new' }))?.isNew).toBe(true)
  })
})

describe('labels and fingerprints', () => {
  it('names the item after the registrable domain', () => {
    expect(loginItemName('banco.mickaelfm.me')).toBe('mickaelfm.me')
  })

  it('labels a login by account and host, never by password', () => {
    expect(loginLabel({ username: 'me@example.com', host: 'banco.mickaelfm.me' })).toBe(
      'me@example.com on banco.mickaelfm.me'
    )
    expect(loginLabel({ username: '', host: 'banco.mickaelfm.me' })).toBe('banco.mickaelfm.me')
  })

  it('fingerprints without carrying the password itself', () => {
    const one = loginFingerprint({ host: 'a.com', username: 'me', password: 'hunter22' })
    const two = loginFingerprint({ host: 'a.com', username: 'ME', password: 'hunter22' })
    const other = loginFingerprint({ host: 'a.com', username: 'me', password: 'other-one' })
    expect(one).toBe(two)
    expect(one).not.toBe(other)
    expect(one).not.toContain('hunter22')
  })
})

describe('normalizeLoginFragment', () => {
  it('refuses a payload with neither half', () => {
    expect(normalizeLoginFragment({ url: 'https://x.com' })).toBeNull()
    expect(normalizeLoginFragment(null)).toBeNull()
  })

  it('caps what a hostile page can push through the channel', () => {
    const huge = normalizeLoginFragment({
      username: 'u'.repeat(5000),
      password: 'p'.repeat(5000),
      url: `https://x.com/${'q'.repeat(5000)}`
    })
    expect(huge?.username.length).toBe(200)
    expect(huge?.password.length).toBe(200)
    expect(huge?.url.length).toBe(2048)
  })

  it('defaults every flag to the safe side', () => {
    const f = normalizeLoginFragment({ password: 'hunter22', submitted: 'yes', kind: 'weird' })
    expect(f?.submitted).toBe(false)
    expect(f?.kind).toBe('current')
    expect(f?.hasUsernameField).toBe(false)
  })
})
