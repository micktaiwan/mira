import { describe, it, expect } from 'vitest'
import { reduceHover, hoverText, EMPTY_HOVER, JS_ACTION_LABEL, type HoverState } from './hover'

describe('reduceHover', () => {
  it('records a navigable link URL from a target event', () => {
    const s = reduceHover(EMPTY_HOVER, { type: 'target', url: 'https://a.com/x' })
    expect(s).toEqual({ targetUrl: 'https://a.com/x', jsAction: false })
  })

  it('clears the link URL when the cursor leaves it (empty target url)', () => {
    const on: HoverState = { targetUrl: 'https://a.com', jsAction: false }
    expect(reduceHover(on, { type: 'target', url: '' })).toEqual(EMPTY_HOVER)
  })

  it('does NOT treat a javascript: url as a navigable link', () => {
    const s = reduceHover(EMPTY_HOVER, { type: 'target', url: 'javascript:void(0)' })
    expect(s.targetUrl).toBe('')
  })

  it('toggles the JS-action flag from a js event without touching the URL', () => {
    const link: HoverState = { targetUrl: 'https://a.com', jsAction: false }
    expect(reduceHover(link, { type: 'js', active: true })).toEqual({
      targetUrl: 'https://a.com',
      jsAction: true
    })
    expect(reduceHover(link, { type: 'js', active: false }).jsAction).toBe(false)
  })
})

describe('hoverText', () => {
  it('shows nothing when the cursor rests on neither a link nor a control', () => {
    expect(hoverText(EMPTY_HOVER)).toBe('')
  })

  it('shows a real link URL', () => {
    expect(hoverText({ targetUrl: 'https://a.com/x', jsAction: false })).toBe('https://a.com/x')
  })

  it('shows the JS-action label for a JS control', () => {
    expect(hoverText({ targetUrl: '', jsAction: true })).toBe(JS_ACTION_LABEL)
  })

  it('prefers a real link over the JS label when both are set', () => {
    expect(hoverText({ targetUrl: 'https://a.com', jsAction: true })).toBe('https://a.com')
  })
})
