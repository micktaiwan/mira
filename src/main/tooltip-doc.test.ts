import { describe, it, expect } from 'vitest'
import { measureScript, PAD } from './tooltip-doc'

describe('measureScript', () => {
  it('injects the tooltip text as a string literal', () => {
    const script = measureScript('4293 media captured — click to open gallery')
    expect(script).toContain(JSON.stringify('4293 media captured — click to open gallery'))
  })

  it('escapes text so quotes/newlines cannot break out of the literal', () => {
    const script = measureScript('a"b\nc')
    expect(script).toContain(JSON.stringify('a"b\nc'))
  })

  it('widens the layout context before measuring so the bubble is not clamped to the pre-warm window width', () => {
    // Regression: the overlay window is pre-warmed at ~10px, so without a roomy
    // body the inline-block shrink-to-fit collapsed to the widest word and the
    // text wrapped one word per line. The script must force a wide body BEFORE it
    // reads getBoundingClientRect.
    const script = measureScript('x')
    const widen = script.indexOf('document.body.style.width')
    const measure = script.indexOf('getBoundingClientRect')
    expect(widen).toBeGreaterThanOrEqual(0)
    expect(widen).toBeLessThan(measure)
  })

  it('adds the symmetric padding on both axes so the shadow is not clipped', () => {
    const script = measureScript('x')
    expect(script).toContain(`+ ${2 * PAD}`)
  })
})
