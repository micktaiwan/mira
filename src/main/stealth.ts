// Make a Mira web page look like a real Chrome to browser-side detection.
//
// Google's sign-in refuses browsers it reads as "controlled through software automation"
// or "embedded in a different application" (support.google.com/accounts/answer/7675428).
// A live fingerprint probe of Mira showed the one real tell: `window.chrome` exists but is
// EMPTY. Real Chrome — and standalone Chromium browsers like Brave/Arc, which sign into
// Google fine — expose a populated `window.chrome` (`loadTimes`, `csi`, `app`, `runtime`).
// An empty `window.chrome` is the classic headless/automation signal (it's exactly what
// puppeteer-stealth patches). Everything else already checks out: clean Chrome UA,
// `navigator.webdriver === false`, `vendor === "Google Inc."`, no Node/Electron globals
// leaking into the page, real PDF plugins present.
//
// So we restore `window.chrome` in the page's MAIN world, at document-start (before any
// page script runs). Electron preloads run in an ISOLATED world and can't patch the page's
// own `navigator`/`window`; `executeJavaScript` runs too late. The one reliable primitive
// is CDP's `Page.addScriptToEvaluateOnNewDocument`, reached via `webContents.debugger`.
// (No code in Mira opens DevTools, so attaching the debugger conflicts with nothing.)
//
// The shim SOURCE is a pure string constant (unit-tested by evaluating it against a fake
// window). The Electron glue below is thin.

import { app, type WebContents } from 'electron'

/** Script injected into every page's main world at document-start. Populates an empty
 * `window.chrome` to mirror a real Chrome build. Guarded and wrapped so it can never
 * break the page it runs in. */
export const CHROME_SHIM_SOURCE = String.raw`
;(function () {
  try {
    var w = window
    if (typeof w.chrome === 'undefined' || w.chrome === null) {
      Object.defineProperty(w, 'chrome', { value: {}, configurable: true, enumerable: true, writable: true })
    }
    var c = w.chrome
    var now = function () { return Date.now() }
    if (!c.csi) {
      c.csi = function () {
        return { onloadT: now(), startE: now(), pageT: Math.random() * 1000, tran: 15 }
      }
    }
    if (!c.loadTimes) {
      c.loadTimes = function () {
        var t = now() / 1000
        return {
          requestTime: t, startLoadTime: t, commitLoadTime: t,
          finishDocumentLoadTime: t, finishLoadTime: t, firstPaintTime: t,
          firstPaintAfterLoadTime: 0, navigationType: 'Other',
          wasFetchedViaSpdy: true, wasNpnNegotiated: true,
          npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false,
          connectionInfo: 'h2'
        }
      }
    }
    if (!c.app) {
      c.app = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getDetails: function () { return null },
        getIsInstalled: function () { return false },
        runningState: function () { return 'cannot_run' }
      }
    }
    if (!c.runtime) {
      c.runtime = {
        OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
        OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
        PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
        RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
        connect: function () {
          return {
            onDisconnect: { addListener: function () {} },
            onMessage: { addListener: function () {} },
            postMessage: function () {},
            disconnect: function () {}
          }
        },
        sendMessage: function () {},
        id: undefined
      }
    }
  } catch (e) {
    /* never break a page over stealth */
  }
})();
`

// webContents we've already wired, so re-entry (both the global hook and any direct call
// fire for the same view) doesn't attach twice.
const wired = new WeakSet<WebContents>()

/** Wire the window.chrome shim onto one web page. Two layers, because neither alone
 * covers every case:
 *  - CDP `addScriptToEvaluateOnNewDocument` runs at document-start — the correct, earliest
 *    point — but it registers asynchronously, so the view's first (synchronous) loadURL can
 *    commit before it lands (the race that left a freshly-opened tab with an empty
 *    window.chrome, which is why a first sign-in attempt could still be blocked).
 *  - `executeJavaScript` on every `did-navigate` (main-frame commit) and `dom-ready`
 *    re-asserts the shim right after each document commits. Idempotent, runs in the page's
 *    main world, and covers that raced first document. It does NOT deadlock (deferring the
 *    load to await the CDP registration did — that combination hangs executeJavaScript).
 * Never throws — stealth must not break a page or its navigation. */
export function installStealthShim(wc: WebContents): void {
  if (wired.has(wc)) return
  wired.add(wc)
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
    wc.debugger
      .sendCommand('Page.enable')
      .then(() =>
        wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
          source: CHROME_SHIM_SOURCE
        })
      )
      .catch((error) => console.error('[mira] stealth: addScript failed', error))
  } catch (error) {
    console.error('[mira] stealth: debugger attach failed', error)
  }
  const reassert = (): void => {
    wc.executeJavaScript(CHROME_SHIM_SOURCE, true).catch(() => {})
  }
  wc.on('did-navigate', reassert)
  wc.on('dom-ready', reassert)
}

/** Register the shim on every webContents as it is created (`web-contents-created` fires
 * for content views, popups, and the chrome window alike — all harmless). Call once. */
export function installStealth(): void {
  app.on('web-contents-created', (_event, wc) => installStealthShim(wc))
}
