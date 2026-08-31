// chrome.storage.onChanged for extension service workers — the PURE half.
//
// Electron ships the storage change events but only ever dispatches them to
// RENDERER contexts. A service worker sees nothing: not another context's
// writes, not even its own. Measured with a probe extension loaded in Mira
// (permissions ["storage"], a worker registering all three of
// chrome.storage.onChanged / chrome.storage.local.onChanged /
// chrome.storage.session.onChanged):
//   - an extension PAGE received every event, including the ones caused by the
//     worker's own chrome.storage.session.set;
//   - the worker received none of them, ever — its own write included.
// Reads and writes themselves are shared correctly: the worker reads back what
// the page wrote and vice versa. Only the notification is missing.
//
// What that costs a password manager (Bitwarden, the reason this file exists):
// its storage service builds its cross-context `updates$` observable straight
// from `<area>.onChanged` (class ZR of its background bundle). The vault is
// unlocked in the POPUP, which writes `user_<id>_crypto_userKey` into
// chrome.storage.session; the worker is never told, so its cached view of that
// key stays null forever and `authService.getAuthStatus()` answers Locked.
// Visible symptom, and how this file was found: right-clicking a page on an
// unlocked vault offered "Unlock your vault" under every Bitwarden submenu —
// the `noAccess()` branch of its context-menu handler.
//
// The bridge, in one line: every extension context tells main WHICH keys it
// just wrote or removed, main forwards that to the extension's service worker,
// and a shimmed onChanged there dispatches it.
//
// ---------------------------------------------------------------------------
// The one deliberate deviation from Chrome: NO VALUES.
//
// A delivered change says which key moved and whether it was saved or removed
// (`'newValue' in change`, exactly what a state framework switches on), but
// carries neither `oldValue` nor a real `newValue`. A listener that needs the
// value reads it back with chrome.storage.get — which a service worker has to
// do anyway every time it restarts.
//
// That is not frugality, it is the difference between working and hanging. The
// first cut DID carry values: it read the old one before each write and shipped
// old+new to main, which echoed the change set back. Bitwarden keeps its
// decrypted vault in ONE chrome.storage.local key of 1.45 MB
// (`session_<user>_ciphersMemory_decryptedCiphers`, measured on a real profile,
// next to a 1.66 MB `_ciphers_ciphers`) and rewrites it on every sync, unlock
// and cipher touch. Each of those writes became a 1.45 MB read plus ~3 MB
// across the process boundary and 1.45 MB back — on the worker's hot path, at
// unlock time. Its context menu never came back up.
//
// Carrying values again would need a size budget, and a size budget cannot be
// computed without serializing the value first. Names only has no such problem.
// ---------------------------------------------------------------------------
//
// Two more things it deliberately does NOT do:
//   - touch renderer contexts' events. Their native onChanged works; the frame
//     half only reports writes, it never dispatches, so nothing double-fires.
//   - deliver to a worker that said it has no storage listener. It announces
//     that once at startup, before its own script runs; a worker main never
//     heard from is treated as listening, so a lost announcement costs a few
//     tiny messages rather than a silently dead bridge.
//
// Pure and unit-tested here; the Electron edges (preload registration, worker
// ipc, routing) live in extension-storage-events-service.ts.

/** send, any extension context -> main: the keys one write just touched. */
export const STORAGE_REPORT_CHANNEL = 'mira-storage-report'
/** send, main -> service worker: one change to dispatch. */
export const STORAGE_EVENT_CHANNEL = 'mira-storage-event'
/** send, service worker -> main: whether it currently has any storage listener.
 * Announced once at startup and on every edge after that. The gate that keeps
 * an extension ignoring storage from paying for this bridge at all. */
export const STORAGE_LISTEN_CHANNEL = 'mira-storage-listening'

/** The storage areas this bridge covers. `sync` and `managed` are absent on
 * purpose: electron-chrome-extensions aliases both to the `local` object
 * itself (verified: `chrome.storage.local === chrome.storage.sync`), so a write
 * through either IS a local write and is reported as one. */
export const STORAGE_AREAS = ['local', 'session'] as const

export type StorageAreaName = (typeof STORAGE_AREAS)[number]

/** What a context sends after a write: which keys were saved, which removed.
 * A `clear()` reports every key the area held as removed. */
export interface StorageReport {
  area: StorageAreaName
  saved: string[]
  removed: string[]
}

export function isStorageArea(value: unknown): value is StorageAreaName {
  return typeof value === 'string' && (STORAGE_AREAS as readonly string[]).includes(value)
}

/** Validate a report coming from a renderer or a worker, and normalize it:
 * non-string entries dropped, duplicates collapsed, and a key that is both
 * saved and removed counted as saved (the write is what happened last).
 * Returns null when the payload is malformed or touches nothing — a bad payload
 * is a bug in the shim, not something to guess around. */
export function readStorageReport(payload: unknown): StorageReport | null {
  if (!payload || typeof payload !== 'object') return null
  const { area, saved, removed } = payload as {
    area?: unknown
    saved?: unknown
    removed?: unknown
  }
  if (!isStorageArea(area)) return null
  const savedKeys = keyList(saved)
  const removedKeys = keyList(removed).filter((key) => !savedKeys.includes(key))
  if (savedKeys.length === 0 && removedKeys.length === 0) return null
  return { area, saved: savedKeys, removed: removedKeys }
}

/** Whether a worker just said it has (or no longer has) storage listeners.
 * null for a payload that says neither. */
export function readListening(payload: unknown): boolean | null {
  if (!payload || typeof payload !== 'object') return null
  const { listening } = payload as { listening?: unknown }
  return typeof listening === 'boolean' ? listening : null
}

/** A deduped list of non-empty string keys, or [] for anything else. */
function keyList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string' && entry !== '' && !seen.includes(entry)) seen.push(entry)
  }
  return seen
}

// ---------------------------------------------------------------------------
// Injected halves
// ---------------------------------------------------------------------------

/** Wrap an area's writers so every write reports its KEYS. Shared verbatim by
 * the worker and the frame halves — the only difference between them is what
 * the bridge does with the report.
 *
 * Nothing is read before a write and nothing is awaited before it, so a write
 * is never delayed and two rapid writes keep their order. `clear()` is the one
 * exception: it needs the key NAMES the area held, so it asks for them (via
 * `getKeys` when Electron has it, a full read otherwise) in the same tick,
 * before the wipe.
 *
 * `chrome.storage.local`, `.sync` and `.managed` are the same object (the lib
 * aliases them), hence the marker guard — wrapping it twice would report every
 * local write twice. */
const STORAGE_WRAP_WRITERS = `function (chrome, areaName, report) {
  var area = chrome.storage[areaName];
  if (!area || area.__miraStorageWrapped) return;
  try { Object.defineProperty(area, '__miraStorageWrapped', { value: true }); }
  catch (_) { return; }

  var origGet = area.get;
  var origGetKeys = area.getKeys;
  var origSet = area.set;
  var origRemove = area.remove;
  var origClear = area.clear;

  // Chrome accepts both a trailing callback and a promise; keep both working.
  var callbackOf = function (args) {
    return typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
  };
  var withoutCallback = function (args, cb) {
    return cb ? Array.prototype.slice.call(args, 0, -1) : Array.prototype.slice.call(args);
  };

  // A failed write reports nothing: an event for a change that did not happen
  // is worse than the missing one this whole file is about.
  var run = function (orig, args, announce) {
    var cb = callbackOf(args);
    var result = orig.apply(area, withoutCallback(args, cb));
    var settled = Promise.resolve(result).then(
      function (value) {
        try { announce(); } catch (_) {}
        if (cb) { try { cb(value); } catch (_) {} }
        return value;
      },
      function (error) {
        if (cb) { try { cb(); } catch (_) {} }
        throw error;
      }
    );
    if (cb) { settled.catch(function () {}); return undefined; }
    return settled;
  };

  var keyList = function (keys) {
    if (Array.isArray(keys)) {
      var out = [];
      for (var i = 0; i < keys.length; i++) if (typeof keys[i] === 'string') out.push(keys[i]);
      return out;
    }
    return typeof keys === 'string' ? [keys] : [];
  };

  if (typeof origSet === 'function') {
    area.set = function (items) {
      var saved = items && typeof items === 'object' ? Object.keys(items) : [];
      return run(origSet, arguments, function () { if (saved.length) report(areaName, saved, []); });
    };
  }
  if (typeof origRemove === 'function') {
    area.remove = function (keys) {
      var removed = keyList(keys);
      return run(origRemove, arguments, function () { if (removed.length) report(areaName, [], removed); });
    };
  }
  if (typeof origClear === 'function') {
    area.clear = function () {
      var namesP;
      try {
        namesP = typeof origGetKeys === 'function'
          ? Promise.resolve(origGetKeys.call(area))
          : Promise.resolve(origGet.call(area, null)).then(function (all) { return Object.keys(all || {}); });
      } catch (_) { namesP = Promise.resolve([]); }
      namesP = namesP.then(
        function (names) { return Array.isArray(names) ? names : []; },
        function () { return []; }
      );
      return run(origClear, arguments, function () {
        namesP.then(function (names) { if (names.length) report(areaName, [], names); });
      });
    };
  }
}`

/** Main-world half installed in every extension service worker: real
 * onChanged events in place of the inert ones, plus the write reporting.
 *
 * Registration order matters. This preload runs AFTER
 * electron-chrome-extensions' own, whose service-worker preload rebuilds
 * `chrome` and freezes it. The freeze is shallow — `chrome.storage` is a plain
 * object the lib itself built, and each area object is extensible with writable
 * `set`/`remove`/`clear` (measured in a worker) — which is what lets these
 * assignments stick.
 *
 * The events go in with defineProperty, NEVER assignment: an area's `onChanged`
 * is an accessor with a getter and no setter (measured in a worker: `get: true`
 * on chrome.storage.session), so an assignment to it is silently dropped in
 * sloppy mode and the inert native event survives. That is exactly how the
 * first cut of this bridge shipped: it ran, raised nothing, and changed nothing.
 * `chrome.storage.onChanged` at the top is a plain data property; defineProperty
 * covers both.
 *
 * The worker reports its OWN writes too, and main sends them straight back:
 * Chrome fires onChanged in the context that wrote, and an extension that
 * relies on that must see it. */
export const STORAGE_WORKER_MAIN_WORLD = `(bridge) => {
  var g = globalThis;
  if (!bridge || !g.chrome || !g.chrome.storage) return;
  if (g.__miraStorageEvents) return;
  try { Object.defineProperty(g, '__miraStorageEvents', { value: true }); }
  catch (_) { return; }

  var AREAS = ${JSON.stringify(STORAGE_AREAS)};
  var chrome = g.chrome;

  // One listener list per area, plus the all-areas chrome.storage.onChanged.
  // Chrome hands the latter a second argument naming the area.
  var buckets = { any: [] };
  for (var a = 0; a < AREAS.length; a++) buckets[AREAS[a]] = [];

  var listening = null;
  var publish = function () {
    var now = buckets.any.length > 0;
    for (var i = 0; i < AREAS.length && !now; i++) now = buckets[AREAS[i]].length > 0;
    if (now === listening) return;
    listening = now;
    bridge.listening(now);
  };

  var makeEvent = function (list) {
    return {
      addListener: function (fn) { if (typeof fn === 'function') { list.push(fn); publish(); } },
      removeListener: function (fn) {
        for (var i = list.length - 1; i >= 0; i--) if (list[i] === fn) list.splice(i, 1);
        publish();
      },
      hasListener: function (fn) {
        for (var i = 0; i < list.length; i++) if (list[i] === fn) return true;
        return false;
      },
      hasListeners: function () { return list.length > 0; }
    };
  };

  var replace = function (target, value) {
    Object.defineProperty(target, 'onChanged', {
      value: value,
      enumerable: true,
      configurable: true
    });
  };
  for (var j = 0; j < AREAS.length; j++) {
    try { replace(chrome.storage[AREAS[j]], makeEvent(buckets[AREAS[j]])); } catch (_) {}
  }
  try { replace(chrome.storage, makeEvent(buckets.any)); } catch (_) {}

  var wrap = ${STORAGE_WRAP_WRITERS};
  var report = function (areaName, saved, removed) { bridge.report(areaName, saved, removed); };
  for (var k = 0; k < AREAS.length; k++) {
    try { wrap(chrome, AREAS[k], report); } catch (_) {}
  }

  // A saved key carries an EMPTY newValue property: Chrome's save-vs-remove
  // test is "newValue" in change, and that stays exact. The value itself never
  // crosses — see the NO VALUES block at the top of the source file.
  bridge.register(function (payload) {
    if (!payload) return;
    var areaName = payload.area;
    var listeners = buckets[areaName];
    if (!listeners) return;
    if (listeners.length === 0 && buckets.any.length === 0) return;
    var changes = {};
    var touched = false;
    var saved = payload.saved || [];
    var removed = payload.removed || [];
    for (var i = 0; i < saved.length; i++) {
      changes[saved[i]] = { newValue: undefined };
      touched = true;
    }
    for (var j2 = 0; j2 < removed.length; j2++) {
      changes[removed[j2]] = {};
      touched = true;
    }
    if (!touched) return;
    for (var m = 0; m < listeners.length; m++) {
      try { listeners[m](changes); } catch (_) {}
    }
    for (var n = 0; n < buckets.any.length; n++) {
      try { buckets.any[n](changes, areaName); } catch (_) {}
    }
  });

  // Say "not listening" once, before the extension's own script runs. Main
  // treats never-heard-from as listening, so a lost declaration costs a few
  // tiny messages — never a silent bridge, which is the failure this file has
  // already paid for once.
  publish();
}`

/** Service-worker preload (isolated world): the ipc bridge for the half above.
 * Uses the worker's own ipc channel, so main always knows which extension is
 * speaking without trusting the payload. */
export const STORAGE_WORKER_PRELOAD_SOURCE = `(function () {
  if (typeof process === 'undefined' || process.type !== 'service-worker') return;
  var electron;
  try { electron = require('electron'); } catch (_) { return; }
  var ipcRenderer = electron.ipcRenderer;
  var contextBridge = electron.contextBridge;
  if (!ipcRenderer) return;
  var handler = null;
  ipcRenderer.on(${JSON.stringify(STORAGE_EVENT_CHANNEL)}, function (_event, payload) {
    if (!handler) return;
    try { handler(payload); } catch (_) {}
  });
  var bridge = {
    register: function (fn) { if (typeof fn === 'function') handler = fn; },
    report: function (area, saved, removed) {
      try { ipcRenderer.send(${JSON.stringify(STORAGE_REPORT_CHANNEL)}, { area: area, saved: saved, removed: removed }); }
      catch (_) {}
    },
    listening: function (on) {
      try { ipcRenderer.send(${JSON.stringify(STORAGE_LISTEN_CHANNEL)}, { listening: !!on }); }
      catch (_) {}
    }
  };
  var install = ${STORAGE_WORKER_MAIN_WORLD};
  try {
    if (contextBridge && typeof contextBridge.executeInMainWorld === 'function') {
      contextBridge.executeInMainWorld({ func: install, args: [bridge] });
      return;
    }
  } catch (_) { /* fall through */ }
  install(bridge);
})();
`

/** Main-world half installed in extension PAGES (popup, options, a popout, the
 * injected notification/menu iframes): write reporting only. Their own
 * onChanged already works, so this half installs no event and dispatches
 * nothing — it exists so that the unlock a user performs in the popup reaches
 * the worker. */
export const STORAGE_FRAME_MAIN_WORLD = `(bridge) => {
  var g = globalThis;
  if (!bridge || !g.chrome || !g.chrome.storage) return;
  if (g.__miraStorageEvents) return;
  try { Object.defineProperty(g, '__miraStorageEvents', { value: true }); }
  catch (_) { return; }
  var AREAS = ${JSON.stringify(STORAGE_AREAS)};
  var wrap = ${STORAGE_WRAP_WRITERS};
  var report = function (areaName, saved, removed) { bridge.report(areaName, saved, removed); };
  for (var i = 0; i < AREAS.length; i++) {
    try { wrap(g.chrome, AREAS[i], report); } catch (_) {}
  }
}`

/** Frame preload: registered for every frame of the session, so it leaves
 * immediately unless it is running inside an extension page. Web pages have no
 * chrome.storage anyway; the url test just keeps the cost at one comparison. */
export const STORAGE_FRAME_PRELOAD_SOURCE = `(function () {
  var electron;
  try { electron = require('electron'); } catch (_) { return; }
  var ipcRenderer = electron.ipcRenderer;
  var contextBridge = electron.contextBridge;
  if (!ipcRenderer) return;
  var href = '';
  try { href = String(location.href || ''); } catch (_) { return; }
  if (href.indexOf('chrome-extension://') !== 0) return;
  var bridge = {
    report: function (area, saved, removed) {
      try { ipcRenderer.send(${JSON.stringify(STORAGE_REPORT_CHANNEL)}, { area: area, saved: saved, removed: removed }); }
      catch (_) {}
    }
  };
  var install = ${STORAGE_FRAME_MAIN_WORLD};
  try {
    if (contextBridge && typeof contextBridge.executeInMainWorld === 'function') {
      contextBridge.executeInMainWorld({ func: install, args: [bridge] });
      return;
    }
  } catch (_) { /* fall through */ }
  install(bridge);
})();
`
