import { describe, it, expect } from 'vitest'
import {
  loginPickSize,
  pickOptionLabel,
  pickOptionNote,
  renderLoginPickHtml,
  MAX_PICK_OPTIONS,
  type LoginPickOption
} from './login-pick-prompt'
import { parsePromptAnswer } from './card-prompt'

const option = (over: Partial<LoginPickOption> = {}): LoginPickOption => ({
  id: 'item-1',
  username: 'me@example.com',
  name: 'holistics.io',
  exact: true,
  host: 'eu.holistics.io',
  ...over
})

describe('what a row says', () => {
  it('names the account by its username', () => {
    expect(pickOptionLabel(option())).toBe('me@example.com')
  })

  it('falls back to the item name when the vault entry has no username', () => {
    expect(pickOptionLabel(option({ username: '', name: 'Old router' }))).toBe(
      'Old router (no username)'
    )
  })

  it('has something to say even for a nameless entry', () => {
    expect(pickOptionLabel(option({ username: '', name: '' }))).toBe('(no username)')
  })

  it('adds no second line for an account filed under this very host', () => {
    expect(pickOptionNote(option({ exact: true }))).toBe('')
  })

  it('says where a same-site account was saved, which is what tells two apart', () => {
    expect(pickOptionNote(option({ exact: false, host: 'apps.tiime.fr' }))).toBe(
      'saved on apps.tiime.fr'
    )
  })

  it('stays quiet when there is no address to show', () => {
    expect(pickOptionNote(option({ exact: false, host: '' }))).toBe('')
  })
})

describe('loginPickSize', () => {
  it('grows one row at a time', () => {
    expect(loginPickSize(3).height).toBeGreaterThan(loginPickSize(2).height)
  })

  it('stops growing past the cap, and leaves room for the "and N more" line', () => {
    const capped = loginPickSize(MAX_PICK_OPTIONS)
    const over = loginPickSize(MAX_PICK_OPTIONS + 5)
    expect(over.height).toBe(capped.height + 18)
  })

  it('never collapses to nothing on an empty list', () => {
    expect(loginPickSize(0).height).toBe(loginPickSize(1).height)
  })
})

describe('the picker document', () => {
  it('draws one clickable row per account, carrying its vault id', () => {
    const html = renderLoginPickHtml({
      host: 'eu.holistics.io',
      account: 'faivrem@gmail.com',
      options: [
        option({ id: 'a', username: 'ana@x.com' }),
        option({ id: 'b', username: 'bob@x.com' })
      ]
    })
    expect(html).toContain('data-id="a"')
    expect(html).toContain('data-id="b"')
    expect(html).toContain('ana@x.com')
    expect(html).toContain('Which account for eu.holistics.io?')
  })

  it('names the vault the accounts come from', () => {
    const html = renderLoginPickHtml({
      host: 'eu.holistics.io',
      account: 'faivrem@gmail.com',
      options: [option()]
    })
    expect(html).toContain('Vault: faivrem@gmail.com')
  })

  it('cuts the list at the cap and says how many are left', () => {
    const many = Array.from({ length: MAX_PICK_OPTIONS + 3 }, (_, i) =>
      option({ id: `item-${i}`, username: `u${i}@x.com` })
    )
    const html = renderLoginPickHtml({ host: 'x.com', account: 'a@b.c', options: many })
    expect(html.match(/class="pick"/g)).toHaveLength(MAX_PICK_OPTIONS)
    expect(html).toContain('and 3 more in the vault')
  })

  it('escapes what comes from the vault and from the page', () => {
    const html = renderLoginPickHtml({
      host: '<script>evil()</script>',
      account: 'a@b.c',
      options: [option({ id: '"><script>', username: '<img onerror=x>' })]
    })
    expect(html).not.toContain('<script>evil()')
    expect(html).not.toContain('<img onerror=x>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('never carries a password: there is no field for one on this bubble', () => {
    const html = renderLoginPickHtml({
      host: 'eu.holistics.io',
      account: 'faivrem@gmail.com',
      options: [option()]
    })
    expect(html).not.toContain('type="password"')
    expect(html).not.toContain('hunter22')
  })
})

describe('the answer it sends back', () => {
  it('is read as a pick', () => {
    expect(parsePromptAnswer(JSON.stringify({ action: 'pick', id: 'item-9' }))).toEqual({
      action: 'pick',
      id: 'item-9'
    })
  })

  it('is a dismissal when the id is missing or empty', () => {
    expect(parsePromptAnswer(JSON.stringify({ action: 'pick' }))).toBeNull()
    expect(parsePromptAnswer(JSON.stringify({ action: 'pick', id: '' }))).toBeNull()
    expect(parsePromptAnswer(JSON.stringify({ action: 'pick', id: 7 }))).toBeNull()
  })

  it('leaves the save and unlock answers alone', () => {
    expect(parsePromptAnswer(JSON.stringify({ action: 'save' }))).toEqual({ action: 'save' })
    expect(parsePromptAnswer(JSON.stringify({ action: 'unlock', password: 'x' }))).toEqual({
      action: 'unlock',
      password: 'x'
    })
  })
})
