import { describe, it, expect } from 'vitest'
import { CARD_CAPTURE_PRELOAD_SOURCE, CARD_FRAGMENT_CHANNEL } from './card-capture-shim'

/** A fake input, close enough to what the shim reads. */
function input(attrs: Record<string, string>, value = ''): Record<string, unknown> {
  return {
    tagName: 'INPUT',
    type: attrs.type ?? 'text',
    id: attrs.id ?? '',
    value,
    getAttribute: (name: string) => attrs[name] ?? null,
    closest: () => null
  }
}

/** Run the preload source against a fake page and return what it sent over ipc,
 * plus a trigger to fire one of the events it listened to. */
function runShim(protocol = 'https:'): {
  sent: Array<{ channel: string; payload: Record<string, unknown> }>
  fire: (type: string, target: unknown) => void
} {
  const sent: Array<{ channel: string; payload: Record<string, unknown> }> = []
  const listeners: Record<string, (e: { target: unknown }) => void> = {}
  const fakeRequire = (): unknown => ({
    ipcRenderer: {
      send: (channel: string, payload: Record<string, unknown>) => sent.push({ channel, payload })
    }
  })
  const document = {
    addEventListener: (type: string, fn: (e: { target: unknown }) => void) => {
      listeners[type] = fn
    },
    querySelector: () => null
  }
  const location = { protocol, origin: 'https://pay.example.com' }
  const CSS = { escape: (s: string) => s }
  new Function('require', 'document', 'location', 'CSS', CARD_CAPTURE_PRELOAD_SOURCE)(
    fakeRequire,
    document,
    location,
    CSS
  )
  return {
    sent,
    fire: (type, target) => listeners[type]?.({ target })
  }
}

describe('card capture preload source', () => {
  it('reports a card number when the field loses focus', () => {
    const shim = runShim()
    shim.fire('focusout', input({ autocomplete: 'cc-number' }, '4242 4242 4242 4242'))
    expect(shim.sent).toEqual([
      {
        channel: CARD_FRAGMENT_CHANNEL,
        payload: {
          kind: 'number',
          value: '4242 4242 4242 4242',
          frameOrigin: 'https://pay.example.com'
        }
      }
    ])
  })

  it('reports the expiry from a separate iframe field', () => {
    const shim = runShim()
    shim.fire('change', input({ name: 'exp-date', placeholder: 'MM / YY' }, '12/28'))
    expect(shim.sent[0].payload.kind).toBe('expiry')
  })

  it('NEVER reports the security code', () => {
    const shim = runShim()
    shim.fire('focusout', input({ autocomplete: 'cc-csc' }, '123'))
    shim.fire('focusout', input({ name: 'cvv' }, '123'))
    expect(shim.sent).toEqual([])
  })

  it('stays silent on ordinary fields and empty values', () => {
    const shim = runShim()
    shim.fire('focusout', input({ name: 'email', type: 'email' }, 'a@b.c'))
    shim.fire('focusout', input({ autocomplete: 'cc-number' }, '   '))
    expect(shim.sent).toEqual([])
  })

  it('does not install itself outside a real web document', () => {
    const shim = runShim('chrome-extension:')
    shim.fire('focusout', input({ autocomplete: 'cc-number' }, '4242424242424242'))
    expect(shim.sent).toEqual([])
  })
})
