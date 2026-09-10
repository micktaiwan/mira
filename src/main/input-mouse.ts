// The mouse half of scripted input: the pure translation of "click this" into
// (a) a page-side script that resolves the target to viewport coordinates and
// (b) the CDP `Input.dispatchMouseEvent` payloads to send at those coordinates.
// Sibling of input-keys.ts, and pure for the same reason: the dispatch itself
// lives in profiles.ts, so everything decided here is unit-testable without
// Electron.
//
// Why a real CDP click rather than a hand-built MouseEvent in exec-js: a
// dispatched event carries `isTrusted: false`, and the apps worth automating
// ignore those — or handle only some of the sequence, which is worse, because
// the call answers ok and nothing happens. A CDP click is indistinguishable
// from a physical one, and it goes through the same path press-key already uses.

import type { CdpModifier } from './input-keys'

/** One `Input.dispatchMouseEvent` payload. Loosely mirrors the CDP shape. */
export interface CdpMouseEvent {
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased'
  x: number
  y: number
  button: 'left' | 'right' | 'middle' | 'none'
  clickCount: number
  modifiers: number
  buttons?: number
}

// Same bitmask CDP uses for keyboard modifiers (Alt=1, Ctrl=2, Meta=4, Shift=8).
const MODIFIER_BITS: Record<CdpModifier, number> = { alt: 1, ctrl: 2, meta: 4, shift: 8 }

/** Where to click: a css selector, a piece of visible text, or raw viewport
 * coordinates. */
export type ClickTarget =
  | { kind: 'selector'; value: string }
  | { kind: 'text'; value: string }
  | { kind: 'point'; x: number; y: number }

export interface ParsedClick {
  target: ClickTarget
  /** 1-based pick among several matches; 1 unless the caller says otherwise. */
  nth: number
  /** Scroll the target into view before clicking, rather than refusing it. */
  scroll: boolean
  modifiers: CdpModifier[]
  tabId?: string
}

const VALID_MODIFIERS = new Set<CdpModifier>(['alt', 'ctrl', 'meta', 'shift'])

/** Validate the `click` params. One target at a time: with both a selector and
 * a point, whichever we picked would be a coin toss the caller cannot see. */
export function parseClickParams(params: unknown): ParsedClick | { error: string } {
  const p = (params ?? {}) as Record<string, unknown>
  const hasPoint = p.x !== undefined || p.y !== undefined
  const named = (['selector', 'text'] as const).filter(
    (k) => typeof p[k] === 'string' && (p[k] as string).length > 0
  )
  if (named.length + (hasPoint ? 1 : 0) === 0) {
    return { error: 'missing target: "selector", "text", or "x"/"y"' }
  }
  if (named.length + (hasPoint ? 1 : 0) > 1) return { error: 'one target at a time' }

  let target: ClickTarget
  if (hasPoint) {
    if (typeof p.x !== 'number' || typeof p.y !== 'number' || !isFinite(p.x) || !isFinite(p.y)) {
      return { error: '"x" and "y" must both be numbers (viewport coordinates)' }
    }
    if (p.x < 0 || p.y < 0) return { error: '"x" and "y" must be inside the viewport' }
    target = { kind: 'point', x: p.x, y: p.y }
  } else {
    target = { kind: named[0], value: p[named[0]] as string }
  }

  let nth = 1
  if (p.nth !== undefined) {
    if (typeof p.nth !== 'number' || !Number.isInteger(p.nth) || p.nth < 1) {
      return { error: '"nth" must be a positive integer (1-based)' }
    }
    nth = p.nth
  }
  if (p.tabId !== undefined && (typeof p.tabId !== 'string' || p.tabId.trim() === '')) {
    return { error: 'invalid "tabId"' }
  }
  const modifiers = (p.modifiers ?? []) as CdpModifier[]
  if (!Array.isArray(modifiers) || modifiers.some((m) => !VALID_MODIFIERS.has(m))) {
    return { error: 'invalid "modifiers" (alt|ctrl|meta|shift)' }
  }

  const out: ParsedClick = { target, nth, scroll: p.scroll === true, modifiers }
  if (typeof p.tabId === 'string') out.tabId = p.tabId
  return out
}

/** Fold modifier names into the CDP bitmask. */
export function mouseModifierMask(modifiers: readonly CdpModifier[]): number {
  return modifiers.reduce((mask, m) => mask | (MODIFIER_BITS[m] ?? 0), 0)
}

/** The three payloads of one left click at (x, y).
 *
 * `mouseMoved` first, and it is not decoration: menus, dropdowns and anything
 * built on hover only mount their target once the pointer is over it, so a
 * press with no preceding move lands on an element that is not there yet.
 * `buttons: 1` on the release matches what a real device sends while the button
 * is still down. */
export function mouseDispatchEvents(
  x: number,
  y: number,
  opts: { modifiers?: readonly CdpModifier[]; clickCount?: number } = {}
): CdpMouseEvent[] {
  const modifiers = mouseModifierMask(opts.modifiers ?? [])
  const clickCount = opts.clickCount ?? 1
  const at = { x: Math.round(x), y: Math.round(y), modifiers }
  return [
    { type: 'mouseMoved', ...at, button: 'none', clickCount: 0 },
    { type: 'mousePressed', ...at, button: 'left', clickCount, buttons: 1 },
    { type: 'mouseReleased', ...at, button: 'left', clickCount, buttons: 1 }
  ]
}

/** What the page-side resolution script answers. */
export interface ClickPoint {
  x: number
  y: number
  /** How the element reads in a report: its tag plus a scrap of its own text. */
  label: string
}

function literal(value: string): string {
  return JSON.stringify(value)
}

/** The script that resolves a selector/text target to a click point INSIDE the
 * page. It returns a plain object (never throws across the bridge) so the main
 * side can turn a miss into a precise refusal rather than a mystery.
 *
 * Text matching keeps only the DEEPEST element carrying the text: every ancestor
 * up to <body> "contains" the words, and clicking <body> at the centre of a menu
 * item is exactly the kind of near-miss that looks like a success. */
export function clickTargetScript(
  target: Exclude<ClickTarget, { kind: 'point' }>,
  opts: { nth: number; scroll: boolean }
): string {
  const v = literal(target.value)
  const collect =
    target.kind === 'selector'
      ? `Array.from(document.querySelectorAll(${v}))`
      : `(() => {
          const needle = ${v}
          const all = Array.from(document.querySelectorAll('body *')).filter((el) => {
            const t = el.innerText
            return typeof t === 'string' && t.includes(needle)
          })
          // Deepest only: drop any element that has a matching descendant.
          return all.filter((el) => !all.some((other) => other !== el && el.contains(other)))
        })()`
  return `(() => {
  const nth = ${opts.nth}
  const scroll = ${opts.scroll ? 'true' : 'false'}
  const els = ${collect}
  const visible = els.filter((el) => {
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return false
    const style = getComputedStyle(el)
    return style.visibility !== 'hidden' && style.display !== 'none'
  })
  if (visible.length === 0) {
    return { ok: false, reason: els.length > 0 ? 'found ' + els.length + ' match(es), none visible' : 'no match' }
  }
  if (nth > visible.length) {
    return { ok: false, reason: 'asked for match ' + nth + ' of ' + visible.length }
  }
  const el = visible[nth - 1]
  if (scroll) el.scrollIntoView({ block: 'center', inline: 'center' })
  const r = el.getBoundingClientRect()
  const x = r.left + r.width / 2
  const y = r.top + r.height / 2
  const w = window.innerWidth
  const h = window.innerHeight
  if (x < 0 || y < 0 || x > w || y > h) {
    return { ok: false, reason: 'the target is outside the viewport (at ' + Math.round(x) + ',' + Math.round(y) + ' of ' + w + '×' + h + '); pass scroll:true' }
  }
  // What the page actually gets clicked on at that point. When it is neither the
  // target nor one of its children, something covers it (a modal, a sticky bar)
  // and the click would go to that instead.
  const hit = document.elementFromPoint(x, y)
  if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
    return { ok: false, reason: 'the target is covered by <' + hit.tagName.toLowerCase() + '> at that point' }
  }
  const own = (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 40)
  return { ok: true, x, y, label: '<' + el.tagName.toLowerCase() + '>' + (own ? ' ' + JSON.stringify(own) : ''), matches: visible.length }
})()`
}

/** Read back what the resolution script answered. Anything that is not a clean
 * point is turned into an Error message the caller can act on. */
export function interpretClickTarget(raw: unknown): ClickPoint | { error: string } {
  if (raw === null || typeof raw !== 'object') {
    return { error: `could not resolve the click target (page returned ${JSON.stringify(raw)})` }
  }
  const r = raw as Record<string, unknown>
  if (r.ok !== true) {
    return { error: typeof r.reason === 'string' ? r.reason : 'could not resolve the click target' }
  }
  if (typeof r.x !== 'number' || typeof r.y !== 'number') {
    return { error: 'the page returned no coordinates for the click target' }
  }
  return { x: r.x, y: r.y, label: typeof r.label === 'string' ? r.label : 'element' }
}
