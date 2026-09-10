import { describe, it, expect } from 'vitest'
import {
  clickTargetScript,
  interpretClickTarget,
  mouseDispatchEvents,
  mouseModifierMask,
  parseClickParams
} from './input-mouse'
import type { ClickPoint, ParsedClick } from './input-mouse'

/** Narrow a parse result to the success side (or fail the test saying why). */
function parsed(result: ParsedClick | { error: string }): ParsedClick {
  if ('error' in result) throw new Error(`expected a target, got error: ${result.error}`)
  return result
}

/** Narrow a click-point result to the error side. */
function pointRefusal(result: ClickPoint | { error: string }): string {
  if (!('error' in result)) throw new Error('expected a refusal, got a point')
  return result.error
}

/** Narrow a parse result to the error side. */
function refusal(result: ParsedClick | { error: string }): string {
  if (!('error' in result)) throw new Error('expected a refusal, got a parsed target')
  return result.error
}

describe('parseClickParams', () => {
  it('takes a selector target, defaulting nth and scroll', () => {
    expect(parseClickParams({ selector: 'button.go' })).toEqual({
      target: { kind: 'selector', value: 'button.go' },
      nth: 1,
      scroll: false,
      modifiers: []
    })
  })

  it('takes a text target, an nth, a scroll and a tabId', () => {
    expect(parseClickParams({ text: 'Settings', nth: 2, scroll: true, tabId: 't1' })).toEqual({
      target: { kind: 'text', value: 'Settings' },
      nth: 2,
      scroll: true,
      modifiers: [],
      tabId: 't1'
    })
  })

  it('takes raw viewport coordinates', () => {
    expect(parsed(parseClickParams({ x: 320, y: 180 })).target).toEqual({
      kind: 'point',
      x: 320,
      y: 180
    })
  })

  it('refuses no target, and refuses two', () => {
    expect(parseClickParams({})).toEqual({
      error: 'missing target: "selector", "text", or "x"/"y"'
    })
    expect(parseClickParams({ selector: 'a', x: 1, y: 2 })).toEqual({
      error: 'one target at a time'
    })
  })

  it('refuses half a point: y alone is not a target', () => {
    expect(refusal(parseClickParams({ x: 10 }))).toMatch(/both be numbers/)
  })

  it('refuses a zero or fractional nth, and an unknown modifier', () => {
    expect(refusal(parseClickParams({ text: 'a', nth: 0 }))).toMatch(/positive integer/)
    expect(refusal(parseClickParams({ text: 'a', nth: 1.5 }))).toMatch(/positive integer/)
    expect(refusal(parseClickParams({ text: 'a', modifiers: ['hyper'] }))).toMatch(
      /invalid "modifiers"/
    )
  })
})

describe('mouseDispatchEvents', () => {
  it('moves, presses and releases at the same rounded point', () => {
    const evs = mouseDispatchEvents(10.4, 20.6)
    expect(evs.map((e) => e.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    expect(evs.every((e) => e.x === 10 && e.y === 21)).toBe(true)
  })

  it('moves before pressing, because hover-mounted targets do not exist yet otherwise', () => {
    const [move, down, up] = mouseDispatchEvents(5, 5)
    expect(move.button).toBe('none')
    expect(move.clickCount).toBe(0)
    expect(down.button).toBe('left')
    expect(down.clickCount).toBe(1)
    expect(down.buttons).toBe(1)
    expect(up.type).toBe('mouseReleased')
  })

  it('carries modifiers as the CDP bitmask', () => {
    expect(mouseModifierMask(['meta', 'shift'])).toBe(12)
    expect(mouseDispatchEvents(1, 1, { modifiers: ['meta'] })[1].modifiers).toBe(4)
  })
})

describe('clickTargetScript', () => {
  it('queries the selector and injects it as a literal', () => {
    const js = clickTargetScript(
      { kind: 'selector', value: 'a[href="/x"]' },
      {
        nth: 1,
        scroll: false
      }
    )
    expect(js).toContain('document.querySelectorAll("a[href=\\"/x\\"]")')
    expect(js).toContain('const nth = 1')
    expect(js).toContain('const scroll = false')
  })

  it('keeps only the deepest element carrying the text', () => {
    // Every ancestor up to <body> "contains" the words; clicking <body> at the
    // centre of a menu item is the near-miss that reads as a success.
    const js = clickTargetScript({ kind: 'text', value: 'Settings' }, { nth: 1, scroll: false })
    expect(js).toContain('el.contains(other)')
    expect(js).toContain('innerText')
  })

  it('checks visibility, viewport bounds and what actually sits at the point', () => {
    const js = clickTargetScript({ kind: 'selector', value: '.go' }, { nth: 2, scroll: true })
    expect(js).toContain('getComputedStyle')
    expect(js).toContain('outside the viewport')
    expect(js).toContain('elementFromPoint')
    expect(js).toContain('scrollIntoView')
    expect(js).toContain('const nth = 2')
  })
})

describe('interpretClickTarget', () => {
  it('reads back a resolved point', () => {
    expect(interpretClickTarget({ ok: true, x: 12, y: 34, label: '<button> "Go"' })).toEqual({
      x: 12,
      y: 34,
      label: '<button> "Go"'
    })
  })

  it('passes the page-side reason through, so the caller knows what failed', () => {
    expect(interpretClickTarget({ ok: false, reason: 'no match' })).toEqual({ error: 'no match' })
    expect(
      interpretClickTarget({ ok: false, reason: 'the target is covered by <div> at that point' })
    ).toEqual({ error: 'the target is covered by <div> at that point' })
  })

  it('refuses a malformed answer rather than clicking at 0,0', () => {
    expect(pointRefusal(interpretClickTarget(null))).toMatch(/could not resolve/)
    expect(pointRefusal(interpretClickTarget('nope'))).toMatch(/could not resolve/)
    expect(pointRefusal(interpretClickTarget({ ok: true }))).toMatch(/no coordinates/)
  })
})
