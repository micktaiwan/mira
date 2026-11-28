import { describe, expect, it } from 'vitest'
import {
  armDeliveryScript,
  deliveryVerdict,
  droppedInputMessage,
  readDeliveryScript
} from './input-delivery'

// A minimal stand-in for the page: just enough window/document for the two
// scripts to run for real, so the test exercises the strings that ship.
interface FakePage {
  window: Record<string | symbol, unknown>
  run: (script: string) => unknown
  fire: (type: string) => void
  listenerCount: () => number
}

function fakePage(opts: {
  under?: { tagName: string } | null
  focused?: { tagName: string }
}): FakePage {
  const listeners = new Map<string, Set<() => void>>()
  const window: Record<string | symbol, unknown> = {
    addEventListener: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn)
    },
    removeEventListener: (type: string, fn: () => void) => {
      listeners.get(type)?.delete(fn)
    }
  }
  const document = {
    elementFromPoint: () => (opts.under === undefined ? { tagName: 'BUTTON' } : opts.under),
    activeElement: opts.focused ?? { tagName: 'BODY' }
  }
  const run = (script: string): unknown =>
    new Function('window', 'document', `return ${script}`)(window, document)
  const fire = (type: string): void => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn()
  }
  const listenerCount = (): number => [...listeners.values()].reduce((n, set) => n + set.size, 0)
  return { window, run, fire, listenerCount }
}

describe('delivery probe scripts', () => {
  it('sees a click that reaches the page', () => {
    const page = fakePage({})
    const observable = page.run(armDeliveryScript('mouse', { x: 10, y: 20 }))
    page.fire('pointerdown')
    expect(deliveryVerdict(observable, page.run(readDeliveryScript(true)))).toBe('delivered')
  })

  it('counts mousedown alone as a delivery', () => {
    const page = fakePage({})
    const observable = page.run(armDeliveryScript('mouse', { x: 10, y: 20 }))
    page.fire('mousedown')
    expect(deliveryVerdict(observable, page.run(readDeliveryScript(true)))).toBe('delivered')
  })

  it('reports a click the page never received as dropped', () => {
    const page = fakePage({})
    const observable = page.run(armDeliveryScript('mouse', { x: 10, y: 20 }))
    expect(deliveryVerdict(observable, page.run(readDeliveryScript(true)))).toBe('dropped')
  })

  it('sees a key press, and reports a missing one as dropped', () => {
    const hit = fakePage({})
    const a = hit.run(armDeliveryScript('key'))
    hit.fire('keydown')
    expect(deliveryVerdict(a, hit.run(readDeliveryScript(true)))).toBe('delivered')

    const miss = fakePage({})
    const b = miss.run(armDeliveryScript('key'))
    expect(deliveryVerdict(b, miss.run(readDeliveryScript(true)))).toBe('dropped')
  })

  it('does not judge a click aimed at an iframe', () => {
    const page = fakePage({ under: { tagName: 'IFRAME' } })
    const observable = page.run(armDeliveryScript('mouse', { x: 10, y: 20 }))
    expect(observable).toBe(false)
    expect(deliveryVerdict(observable, page.run(readDeliveryScript(true)))).toBe('unknown')
  })

  it('does not judge a click aimed at a named frame', () => {
    expect(armDeliveryScript('mouse', { x: 5, y: 5 }, true)).toBe('false')
  })

  it('does not judge a click with no element under the point', () => {
    const page = fakePage({ under: null })
    expect(page.run(armDeliveryScript('mouse', { x: 10, y: 20 }))).toBe(false)
  })

  it('does not judge a key press while a frame holds focus', () => {
    const page = fakePage({ focused: { tagName: 'IFRAME' } })
    expect(page.run(armDeliveryScript('key'))).toBe(false)
  })

  it('reads null once the page that held the probe is gone', () => {
    const before = fakePage({})
    const observable = before.run(armDeliveryScript('key'))
    const after = fakePage({})
    expect(after.run(readDeliveryScript(true))).toBeNull()
    expect(deliveryVerdict(observable, null)).toBe('unknown')
  })

  it('leaves nothing behind after the final read', () => {
    const page = fakePage({})
    page.run(armDeliveryScript('mouse', { x: 1, y: 1 }))
    expect(page.listenerCount()).toBe(2)
    page.run(readDeliveryScript(false))
    expect(page.listenerCount()).toBe(2)
    page.run(readDeliveryScript(true))
    expect(page.listenerCount()).toBe(0)
    expect(Object.getOwnPropertySymbols(page.window)).toHaveLength(0)
  })

  it('re-arming drops the listeners of the previous probe', () => {
    const page = fakePage({})
    page.run(armDeliveryScript('mouse', { x: 1, y: 1 }))
    page.run(armDeliveryScript('key'))
    expect(page.listenerCount()).toBe(1)
  })
})

describe('deliveryVerdict', () => {
  it('never fails on an answer it does not understand', () => {
    expect(deliveryVerdict(true, undefined)).toBe('unknown')
    expect(deliveryVerdict(undefined, false)).toBe('unknown')
    expect(deliveryVerdict('true', false)).toBe('unknown')
  })
})

describe('droppedInputMessage', () => {
  it('names what was not received and forbids raising the window', () => {
    expect(droppedInputMessage('mouse')).toContain('no pointerdown for this click')
    expect(droppedInputMessage('key')).toContain('no keydown for this key press')
    expect(droppedInputMessage('key')).toContain('do not raise it yourself')
  })
})
