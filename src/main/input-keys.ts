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

// Punctuation → its US-layout `code` and virtual key code. Typing a character
// only needs `text`, so this used to be left empty — but a SHORTCUT is matched
// on `code`, and an empty one silently matches nothing. Cmd+, (the settings
// shortcut of Notion, Slack, VS Code and most desktop-class web apps) was
// dispatched, accepted, and did nothing at all: the worst shape of failure,
// since the command answered ok.
//
// Shifted characters share their key's code and virtual key code, because that
// is what a real keyboard sends: `?` is Slash with shift held.
const PUNCTUATION: Record<string, { code: string; keyCode: number }> = {
  ';': { code: 'Semicolon', keyCode: 186 },
  ':': { code: 'Semicolon', keyCode: 186 },
  '=': { code: 'Equal', keyCode: 187 },
  '+': { code: 'Equal', keyCode: 187 },
  ',': { code: 'Comma', keyCode: 188 },
  '<': { code: 'Comma', keyCode: 188 },
  '-': { code: 'Minus', keyCode: 189 },
  _: { code: 'Minus', keyCode: 189 },
  '.': { code: 'Period', keyCode: 190 },
  '>': { code: 'Period', keyCode: 190 },
  '/': { code: 'Slash', keyCode: 191 },
  '?': { code: 'Slash', keyCode: 191 },
  '`': { code: 'Backquote', keyCode: 192 },
  '~': { code: 'Backquote', keyCode: 192 },
  '[': { code: 'BracketLeft', keyCode: 219 },
  '{': { code: 'BracketLeft', keyCode: 219 },
  '\\': { code: 'Backslash', keyCode: 220 },
  '|': { code: 'Backslash', keyCode: 220 },
  ']': { code: 'BracketRight', keyCode: 221 },
  '}': { code: 'BracketRight', keyCode: 221 },
  "'": { code: 'Quote', keyCode: 222 },
  '"': { code: 'Quote', keyCode: 222 },
  '!': { code: 'Digit1', keyCode: 49 },
  '@': { code: 'Digit2', keyCode: 50 },
  '#': { code: 'Digit3', keyCode: 51 },
  $: { code: 'Digit4', keyCode: 52 },
  '%': { code: 'Digit5', keyCode: 53 },
  '^': { code: 'Digit6', keyCode: 54 },
  '&': { code: 'Digit7', keyCode: 55 },
  '*': { code: 'Digit8', keyCode: 56 },
  '(': { code: 'Digit9', keyCode: 57 },
  ')': { code: 'Digit0', keyCode: 48 }
}

// Spelled-out names for the punctuation a shell cannot pass comfortably. `,`
// and `|` have to be quoted to survive zsh, and the first reflex on the command
// line is to type the name — which used to be rejected outright.
const PUNCTUATION_ALIASES: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Dot: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Colon: ':',
  Quote: "'",
  Apostrophe: "'",
  Backquote: '`',
  Backtick: '`',
  Minus: '-',
  Dash: '-',
  Underscore: '_',
  Equal: '=',
  Plus: '+',
  BracketLeft: '[',
  BracketRight: ']',
  Space: ' '
}

// macOS virtual key codes (`kVK_*`, Carbon HIToolbox), keyed by DOM `code`.
//
// Why this table exists: CDP's `nativeVirtualKeyCode` is, as its name says, the
// NATIVE one — and we used to fill it with the Windows code (69 for E, 188 for
// comma). On macOS those numbers name other physical keys, or none at all, so
// Cocoa rebuilt the event with empty `charactersIgnoringModifiers`. Chromium
// hands a key the page did not consume back to the native menu, and an empty
// string is exactly what a menu item with NO key equivalent carries — the first
// of them being `{ role: 'about' }` (menu.ts). That is the standing explanation
// for the About panel popping during scripted Cmd+<key>: consistent with the
// code on both sides, not reproduced under a debugger. See `unmodifiedText`
// below — the two together are what Cocoa matches key equivalents on.
const MAC_VIRTUAL_KEYS: Record<string, number> = {
  KeyA: 0,
  KeyS: 1,
  KeyD: 2,
  KeyF: 3,
  KeyH: 4,
  KeyG: 5,
  KeyZ: 6,
  KeyX: 7,
  KeyC: 8,
  KeyV: 9,
  KeyB: 11,
  KeyQ: 12,
  KeyW: 13,
  KeyE: 14,
  KeyR: 15,
  KeyY: 16,
  KeyT: 17,
  KeyO: 31,
  KeyU: 32,
  KeyI: 34,
  KeyP: 35,
  KeyL: 37,
  KeyJ: 38,
  KeyK: 40,
  KeyN: 45,
  KeyM: 46,
  Digit1: 18,
  Digit2: 19,
  Digit3: 20,
  Digit4: 21,
  Digit6: 22,
  Digit5: 23,
  Digit9: 25,
  Digit7: 26,
  Digit8: 28,
  Digit0: 29,
  Equal: 24,
  Minus: 27,
  BracketRight: 30,
  BracketLeft: 33,
  Quote: 39,
  Semicolon: 41,
  Backslash: 42,
  Comma: 43,
  Slash: 44,
  Period: 47,
  Backquote: 50,
  Enter: 36,
  Tab: 48,
  Space: 49,
  Backspace: 51,
  Escape: 53,
  Delete: 117,
  Home: 115,
  End: 119,
  PageUp: 116,
  PageDown: 121,
  ArrowLeft: 123,
  ArrowRight: 124,
  ArrowDown: 125,
  ArrowUp: 126
}

/** The native virtual key code to send for a DOM `code`. On macOS that is the
 * `kVK_*` value; anywhere else (and for a `code` we do not map) the Windows one
 * we already computed. Pure: the platform is a parameter, not a global read. */
export function nativeVirtualKey(code: string, keyCode: number, platform: string): number {
  if (platform !== 'darwin') return keyCode
  return MAC_VIRTUAL_KEYS[code] ?? keyCode
}

/** Resolve a key name into its DOM `code`, virtual key code, and whether it
 * produces text. Throws on an empty or unsupported key. */
export function resolveKey(key: string): { code: string; keyCode: number; printable: boolean } {
  if (typeof key !== 'string' || key.length === 0) throw new Error('missing key')
  const aliased = PUNCTUATION_ALIASES[key]
  if (aliased !== undefined) return resolveKey(aliased)
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
    const punct = PUNCTUATION[key]
    if (punct) return { code: punct.code, keyCode: punct.keyCode, printable: true }
    // An unmapped single character (accented letter, emoji, non-US layout): it
    // can still be typed through `text`, so keep it working rather than refuse.
    // A shortcut built on it will not fire, and that is a layout question, not
    // a missing mapping.
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
  modifiers: readonly CdpModifier[] = [],
  platform: string = process.platform
): CdpKeyEvent[] {
  const { code, keyCode, printable } = resolveKey(key)
  const mask = modifierMask(modifiers)
  const suppressed = MODIFIER_BITS.ctrl | MODIFIER_BITS.meta | MODIFIER_BITS.alt
  const producesText = printable && (mask & suppressed) === 0
  const base = {
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: nativeVirtualKey(code, keyCode, platform),
    modifiers: mask
  }
  const down: CdpKeyEvent = { type: 'keyDown', ...base }
  // `text` is what gets INSERTED, so a shortcut must not carry it. But
  // `unmodifiedText` is what the character would have been without ctrl/meta/alt,
  // and macOS matches menu key equivalents on exactly that: leaving it out made a
  // Cmd+<key> event look character-less to the menu (see MAC_VIRTUAL_KEYS).
  if (printable) down.unmodifiedText = key
  if (producesText) down.text = key
  return [down, { type: 'keyUp', ...base }]
}
