// Pure translation of a key name (KeyboardEvent.key style, e.g. 'e', 'Enter',
// 'ArrowDown') into the CDP `Input.dispatchKeyEvent` payload(s) that simulate a
// REAL keypress inside a page. This backs the `press-key` command.
//
// Why real (CDP) rather than a synthetic DOM KeyboardEvent: many keyboard-driven
// UIs (Kondo/Superhuman-style inboxes: archive with 'e', j/k to move, Escape to
// close) gate their handlers on `event.isTrusted`, or listen at a level a
// dispatched event never reaches. A CDP-injected key is indistinguishable from a
// physical one (isTrusted:true), so those shortcuts fire. Same channel the
// stealth shim already drives (see cdp-eval.ts), so no new transport.
//
// Pure and I/O-free on purpose: the dispatch itself (over wc.debugger) lives in
// profiles.ts; this module only computes WHAT to send, so it is unit-testable
// without Electron.

/** CDP modifier names accepted by `press-key`. */
export type CdpModifier = 'alt' | 'ctrl' | 'meta' | 'shift'

/** One `Input.dispatchKeyEvent` payload. Loosely mirrors the CDP shape we send. */
export interface CdpKeyEvent {
  type: 'keyDown' | 'keyUp'
  key: string
  code: string
  windowsVirtualKeyCode: number
  nativeVirtualKeyCode: number
  modifiers: number
  text?: string
  unmodifiedText?: string
}

// CDP packs active modifiers into a bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8).
const MODIFIER_BITS: Record<CdpModifier, number> = { alt: 1, ctrl: 2, meta: 4, shift: 8 }

// Named (non-printable) keys → their DOM `code` and Windows virtual key code.
// Kept to the set a keyboard-driven UI actually needs; extend as needed.
const NAMED: Record<string, { code: string; keyCode: number }> = {
  Enter: { code: 'Enter', keyCode: 13 },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ' ': { code: 'Space', keyCode: 32 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 }
}

/** Resolve a key name into its DOM `code`, virtual key code, and whether it
 * produces text. Throws on an empty or unsupported key. */
export function resolveKey(key: string): { code: string; keyCode: number; printable: boolean } {
  if (typeof key !== 'string' || key.length === 0) throw new Error('missing key')
  const named = NAMED[key]
  if (named) return { code: named.code, keyCode: named.keyCode, printable: false }
  if (key.length === 1) {
    const upper = key.toUpperCase()
    if (upper >= 'A' && upper <= 'Z') {
      return { code: `Key${upper}`, keyCode: upper.charCodeAt(0), printable: true }
    }
    if (key >= '0' && key <= '9') {
      return { code: `Digit${key}`, keyCode: key.charCodeAt(0), printable: true }
    }
    // Other single printable char (punctuation): best-effort, no reliable
    // `code`, keyCode from the uppercased char. Enough for text entry / most
    // shortcuts that key off `event.key`.
    return { code: '', keyCode: upper.charCodeAt(0), printable: true }
  }
  throw new Error(`unsupported key: ${key}`)
}

/** Fold a list of modifier names into the CDP bitmask. Unknown names are
 * ignored (validation happens at the command boundary). */
export function modifierMask(modifiers: readonly CdpModifier[]): number {
  return modifiers.reduce((mask, m) => mask | (MODIFIER_BITS[m] ?? 0), 0)
}

/** Build the keyDown+keyUp pair for one keypress. A printable key with no
 * ctrl/meta/alt held also carries `text` (so it generates keypress/input, i.e.
 * types the character); a shortcut like Ctrl+E carries no text. */
export function keyToDispatchEvents(
  key: string,
  modifiers: readonly CdpModifier[] = []
): CdpKeyEvent[] {
  const { code, keyCode, printable } = resolveKey(key)
  const mask = modifierMask(modifiers)
  const suppressed = MODIFIER_BITS.ctrl | MODIFIER_BITS.meta | MODIFIER_BITS.alt
  const producesText = printable && (mask & suppressed) === 0
  const base = {
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    modifiers: mask
  }
  const down: CdpKeyEvent = { type: 'keyDown', ...base }
  if (producesText) {
    down.text = key
    down.unmodifiedText = key
  }
  return [down, { type: 'keyUp', ...base }]
}
