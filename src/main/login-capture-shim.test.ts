import { describe, it, expect } from 'vitest'
import { LOGIN_CAPTURE_PRELOAD_SOURCE, LOGIN_FRAGMENT_CHANNEL } from './login-capture-shim'

/** A fake input, close enough to what the shim reads. */
function input(attrs: Record<string, string>, value = ''): Record<string, unknown> {
  return {
    tagName: 'INPUT',
    type: attrs.type ?? 'text',
    id: attrs.id ?? '',
    value,
    form: null,
    getAttribute: (name: string) => attrs[name] ?? null,
    closest: () => null
  }
}

/** A fake clickable control, for the "did the user press Log in?" path. */
function button(text: string, attrs: Record<string, string> = {}): Record<string, unknown> {
  const control: Record<string, unknown> = {
    tagName: 'BUTTON',
    textContent: text,
    id: attrs.id ?? '',
    form: null,
    getAttribute: (name: string) => attrs[name] ?? null
  }
  control.closest = (selector: string): unknown => (selector.includes('button') ? control : null)
  return control
}

/** A fake <form> that holds `fields`, for the submit path. */
function form(fields: Array<Record<string, unknown>>): Record<string, unknown> {
  return { tagName: 'FORM', querySelectorAll: () => fields }
}

/** Run the preload source against a fake page whose inputs are `fields`. */
function runShim(
  fields: Array<Record<string, unknown>>,
  protocol = 'https:'
): {
  sent: Array<Record<string, unknown>>
  channels: string[]
  fire: (type: string, target: unknown, extra?: Record<string, unknown>) => void
} {
  const sent: Array<Record<string, unknown>> = []
  const channels: string[] = []
  const listeners: Record<string, (e: Record<string, unknown>) => void> = {}
  const fakeRequire = (): unknown => ({
    ipcRenderer: {
      send: (channel: string, payload: Record<string, unknown>) => {
        channels.push(channel)
        sent.push(payload)
      }
    }
  })
  const document = {
    addEventListener: (type: string, fn: (e: Record<string, unknown>) => void) => {
      listeners[type] = fn
    },
    querySelector: () => null,
    querySelectorAll: () => fields
  }
  const location = { protocol, href: 'https://banco.mickaelfm.me/login' }
  const CSS = { escape: (s: string) => s }
  new Function('require', 'document', 'location', 'CSS', LOGIN_CAPTURE_PRELOAD_SOURCE)(
    fakeRequire,
    document,
    location,
    CSS
  )
  return {
    sent,
    channels,
    fire: (type, target, extra = {}) => listeners[type]?.({ target, ...extra })
  }
}

describe('login capture preload source', () => {
  const user = input({ type: 'email', name: 'email' }, 'me@example.com')
  const pass = input({ type: 'password', name: 'password' }, 'hunter22')

  it('reports the pair without `submitted` when a field loses focus', () => {
    const shim = runShim([user, pass])
    shim.fire('focusout', pass)
    expect(shim.channels).toEqual([LOGIN_FRAGMENT_CHANNEL])
    expect(shim.sent[0]).toEqual({
      username: 'me@example.com',
      password: 'hunter22',
      kind: 'current',
      hasUsernameField: true,
      submitted: false,
      url: 'https://banco.mickaelfm.me/login'
    })
  })

  it('marks a real form submission as submitted', () => {
    const shim = runShim([user, pass])
    shim.fire('submit', form([user, pass]))
    expect(shim.sent[0].submitted).toBe(true)
  })

  it('marks Enter in a watched field as submitted', () => {
    const shim = runShim([user, pass])
    shim.fire('keydown', pass, { key: 'Enter' })
    expect(shim.sent[0].submitted).toBe(true)
  })

  it('treats a click on "Se connecter" as a submit, and a "show password" eye as nothing', () => {
    const shim = runShim([user, pass])
    shim.fire('click', button('Afficher le mot de passe'))
    expect(shim.sent).toEqual([])
    shim.fire('click', button('Se connecter'))
    expect(shim.sent[0].submitted).toBe(true)
  })

  it('never reports an ordinary field on its own', () => {
    const shim = runShim([input({ type: 'text', name: 'search' }, 'chaussures')])
    shim.fire('focusout', input({ type: 'text', name: 'search' }, 'chaussures'))
    expect(shim.sent).toEqual([])
  })

  it('stays silent while a signup confirmation does not match', () => {
    const fields = [
      input({ type: 'password', autocomplete: 'new-password' }, 'hunter22'),
      input({ type: 'password', name: 'confirm' }, 'hunt')
    ]
    const shim = runShim(fields)
    shim.fire('submit', form(fields))
    expect(shim.sent).toEqual([])
  })

  it('reports a signup pair as `new` once the confirmation agrees', () => {
    const fields = [
      input({ type: 'email', name: 'email' }, 'me@example.com'),
      input({ type: 'password', autocomplete: 'new-password' }, 'hunter22'),
      input({ type: 'password', name: 'confirm' }, 'hunter22')
    ]
    const shim = runShim(fields)
    shim.fire('submit', form(fields))
    expect(shim.sent[0]).toMatchObject({ password: 'hunter22', kind: 'new', submitted: true })
  })

  it('drops an identical repeat, but never drops a submit', () => {
    const shim = runShim([user, pass])
    shim.fire('focusout', pass)
    shim.fire('focusout', pass)
    expect(shim.sent).toHaveLength(1)
    shim.fire('submit', form([user, pass]))
    expect(shim.sent).toHaveLength(2)
  })

  it('does not install itself outside a real web document', () => {
    const shim = runShim([user, pass], 'chrome-extension:')
    shim.fire('focusout', pass)
    expect(shim.sent).toEqual([])
  })
})
