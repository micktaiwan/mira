import { describe, it, expect } from 'vitest'
import {
  FORM_MEMORY_PRELOAD_SOURCE,
  FORM_MEMORY_RECORD_CHANNEL,
  FORM_MEMORY_SUGGEST_CHANNEL
} from './form-memory-shim'

/** A fake input, close enough to what the shim reads and writes. */
function input(attrs: Record<string, string> = {}, value = ''): Record<string, unknown> {
  const own: Record<string, string> = { ...attrs }
  return {
    tagName: 'INPUT',
    type: own.type ?? 'text',
    id: own.id ?? '',
    value,
    getAttribute: (name: string) => own[name] ?? null,
    setAttribute: (name: string, v: string) => {
      own[name] = v
    },
    closest: () => null,
    attrs: own
  }
}

/** Run the preload source against a fake page. */
function runShim(
  suggestions: string[] = [],
  protocol = 'https:'
): {
  sent: Array<{ channel: string; payload: Record<string, unknown> }>
  invoked: Array<{ channel: string; payload: Record<string, unknown> }>
  created: Array<Record<string, unknown>>
  fire: (type: string, target: unknown) => void
  setActive: (el: unknown) => void
} {
  const sent: Array<{ channel: string; payload: Record<string, unknown> }> = []
  const invoked: Array<{ channel: string; payload: Record<string, unknown> }> = []
  const created: Array<Record<string, unknown>> = []
  const listeners: Record<string, (e: { target: unknown }) => void> = {}
  const byId: Record<string, unknown> = {}

  const fakeRequire = (): unknown => ({
    ipcRenderer: {
      send: (channel: string, payload: Record<string, unknown>) => sent.push({ channel, payload }),
      invoke: async (channel: string, payload: Record<string, unknown>) => {
        invoked.push({ channel, payload })
        return suggestions
      }
    }
  })

  const element = (tag: string): Record<string, unknown> => {
    const el: Record<string, unknown> = {
      tagName: tag.toUpperCase(),
      id: '',
      value: '',
      textContent: '',
      children: [] as unknown[],
      appendChild(child: unknown) {
        ;(el.children as unknown[]).push(child)
      }
    }
    created.push(el)
    return el
  }

  const document: Record<string, unknown> = {
    activeElement: null,
    documentElement: element('html'),
    addEventListener: (type: string, fn: (e: { target: unknown }) => void) => {
      listeners[type] = fn
    },
    querySelector: () => null,
    getElementById: (id: string) => byId[id] ?? null,
    createElement: (tag: string) => {
      const el = element(tag)
      const original = el as { id: string }
      Object.defineProperty(el, 'id', {
        get: () => original.id,
        set: (v: string) => {
          Object.defineProperty(el, 'id', { value: v, writable: true })
          byId[v] = el
        },
        configurable: true
      })
      return el
    }
  }
  const location = {
    protocol,
    origin: 'https://cfspart.impots.gouv.fr',
    href: 'https://cfspart.impots.gouv.fr/LoginAccess'
  }
  const CSS = { escape: (s: string) => s }
  new Function('require', 'document', 'location', 'CSS', FORM_MEMORY_PRELOAD_SOURCE)(
    fakeRequire,
    document,
    location,
    CSS
  )
  return {
    sent,
    invoked,
    created,
    fire: (type, target) => listeners[type]?.({ target }),
    setActive: (el) => {
      document.activeElement = el
    }
  }
}

describe('form memory preload source', () => {
  it('reports an ordinary field when it loses focus', () => {
    const shim = runShim()
    shim.fire('focusout', input({ name: 'spi' }, '0970773949166'))
    expect(shim.sent).toHaveLength(1)
    expect(shim.sent[0].channel).toBe(FORM_MEMORY_RECORD_CHANNEL)
    expect(shim.sent[0].payload).toMatchObject({
      value: '0970773949166',
      url: 'https://cfspart.impots.gouv.fr/LoginAccess'
    })
    expect((shim.sent[0].payload.attrs as Record<string, string>).name).toBe('spi')
  })

  it('never reads a password, a one-time code or a non-textual input', () => {
    const shim = runShim()
    shim.fire('focusout', input({ name: 'pwd', type: 'password' }, 'hunter2'))
    shim.fire('focusout', input({ name: 'code', autocomplete: 'one-time-code' }, '123456'))
    shim.fire('focusout', input({ name: 'motDePasse' }, 'hunter2'))
    shim.fire('focusout', input({ name: 'avatar', type: 'file' }, 'photo.png'))
    expect(shim.sent).toEqual([])
  })

  it('sends nothing for an empty field', () => {
    const shim = runShim()
    shim.fire('focusout', input({ name: 'spi' }, '   '))
    expect(shim.sent).toEqual([])
  })

  it('stays out of pages that are not http(s)', () => {
    const shim = runShim([], 'file:')
    shim.fire('focusout', input({ name: 'spi' }, '0970773949166'))
    expect(shim.sent).toEqual([])
  })

  it('asks for suggestions on focus and binds the field to a datalist', async () => {
    const shim = runShim(['0970773949166'])
    const el = input({ name: 'spi' })
    shim.setActive(el)
    shim.fire('focusin', el)
    await Promise.resolve()
    await Promise.resolve()

    expect(shim.invoked[0].channel).toBe(FORM_MEMORY_SUGGEST_CHANNEL)
    expect((el.attrs as Record<string, string>).list).toBe('mira-form-memory')
    const datalist = shim.created.find((c) => c.tagName === 'DATALIST')
    expect((datalist?.children as unknown[]).map((o) => (o as { value: string }).value)).toEqual([
      '0970773949166'
    ])
  })

  it('leaves a field alone when there is nothing to offer', async () => {
    const shim = runShim([])
    const el = input({ name: 'spi' })
    shim.setActive(el)
    shim.fire('focusin', el)
    await Promise.resolve()
    await Promise.resolve()
    expect((el.attrs as Record<string, string>).list).toBeUndefined()
  })

  it('never fights a page that ships its own datalist', async () => {
    const shim = runShim(['0970773949166'])
    const el = input({ name: 'spi', list: 'their-list' })
    shim.setActive(el)
    shim.fire('focusin', el)
    await Promise.resolve()
    expect(shim.invoked).toEqual([])
    expect((el.attrs as Record<string, string>).list).toBe('their-list')
  })

  it('asks once per field', async () => {
    const shim = runShim(['0970773949166'])
    const el = input({ name: 'spi' })
    shim.setActive(el)
    shim.fire('focusin', el)
    shim.fire('focusin', el)
    await Promise.resolve()
    expect(shim.invoked).toHaveLength(1)
  })

  it('sweeps the whole form on submit', () => {
    const shim = runShim()
    const form = {
      elements: [
        input({ name: 'spi' }, '0970773949166'),
        input({ name: 'pwd', type: 'password' }, 'hunter2')
      ]
    }
    shim.fire('submit', form)
    expect(shim.sent).toHaveLength(1)
    expect((shim.sent[0].payload.attrs as Record<string, string>).name).toBe('spi')
  })
})
