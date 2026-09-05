// Give `window.open()` a truthy return value when Mira turns the open into a TAB.
//
// Mira's window-open handler (profiles.ts) answers `{ action: 'deny' }` for
// everything that is not a real popup, and opens a Mira tab itself instead — so
// the page gets `null` back where Chrome hands it a WindowProxy. Pages that
// feature-detect on that return value then believe they were blocked: Gmail's
// "Show original" opens its tab AND shows "Grrr! A pop-up blocker may be
// preventing the application from opening the page" (seen 2026-09-04; verified
// with `String(window.open("about:blank"))` → "null" in a live Mira tab).
//
// So we wrap window.open in the page's MAIN world (same CDP injection as the
// stealth chrome shim — see stealth.ts) and substitute a minimal stub object
// when, and only when, the native call returned null/undefined. Real popups
// (OAuth/SSO, which the handler allows) come back as a real WindowProxy and are
// passed through untouched, so `window.opener` round-trips are unaffected.
//
// The stub is deliberately minimal: `closed`, `close()`, `focus()`, `blur()`,
// `postMessage()`, `opener`, `name`. It cannot navigate or be written into — a
// page doing `w.document.write(...)` on it stays broken, exactly as broken as it
// is today with `null` (it threw a TypeError instead).
//
// The wrapper is a Proxy over the native function, not a plain function, so that
// `String(window.open)` still reads "function open() { [native code] }" —
// Function.prototype.toString on a callable Proxy yields the native string. A
// hand-rolled function would print its source and become a new automation tell,
// undoing what stealth.ts exists for.

/** Source injected at document-start into every page's main world. Guarded so it
 * can never break the page it runs in. */
export const WINDOW_OPEN_SHIM_SOURCE = String.raw`
;(function () {
  try {
    var w = window
    var key = '__miraOpenShim'
    var native = w.open
    if (typeof native !== 'function' || w[key] === native) return
    var warnUnwritable = function (prop) {
      try {
        console.warn('[mira] window.open() opened a Mira tab; its ' + prop + ' is not reachable')
      } catch (e) { /* console can be stubbed out */ }
    }
    var makeStub = function () {
      var closed = false
      return {
        get closed() { return closed },
        close: function () { closed = true },
        focus: function () {},
        blur: function () {},
        postMessage: function () {},
        opener: null,
        name: '',
        // The one pattern the stub cannot serve: window.open('') then writing into
        // the handle (print / receipt popups). It was equally broken before the
        // stub (a TypeError on null), but silently so now — say it out loud in the
        // page console so the next occurrence is identifiable instead of invisible.
        get document() { warnUnwritable('document'); return undefined },
        get location() { warnUnwritable('location'); return undefined }
      }
    }
    var proxy = new Proxy(native, {
      apply: function (target, thisArg, args) {
        var result = Reflect.apply(target, thisArg || w, args)
        return result === null || result === undefined ? makeStub() : result
      }
    })
    Object.defineProperty(w, 'open', {
      value: proxy, writable: true, enumerable: true, configurable: true
    })
    Object.defineProperty(w, key, {
      value: proxy, writable: true, enumerable: false, configurable: true
    })
  } catch (e) {
    /* never break a page over this shim */
  }
})();
`
