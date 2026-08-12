// The two injected halves of `externally_connectable` (see external-messaging.ts
// for the why and the pure model): the page-side chrome.runtime a matched web
// page gets, and the service-worker-side onMessageExternal / onConnectExternal
// the extension's listeners land on.
//
// Both follow the injection idiom already used by Mira's other shims (the
// getUserMedia shim, the chrome.offscreen shim): a preload builds an ipc bridge
// in the isolated world and crosses a plain function into the main world with
// contextBridge.executeInMainWorld, so no Electron primitive is ever handed to
// page or extension code. Functions may cross in either direction as arguments,
// which is how the isolated world calls back into the main world here.
//
// Registration order matters on both sides:
//   - the SW half must be registered AFTER electron-chrome-extensions, whose own
//     service-worker preload rebuilds chrome.runtime from scratch and then
//     freezes `chrome`. Freezing `chrome` leaves `chrome.runtime` itself
//     extensible, so running last is what makes the assignment stick.
//   - the page half must survive stealth.ts, which installs a decoy
//     chrome.runtime (no-op sendMessage) on every page so window.chrome doesn't
//     read as headless. Whichever of the two lands first, the result is the
//     same: this half overwrites the decoy's methods and keeps its enums, and
//     stealth's re-assert is a no-op once chrome.runtime exists.

/** sendSync: "does this frame match any extension?" Returns the matching
 * extension ids; an empty array means no API is installed at all. */
export const EXTERNAL_QUERY_CHANNEL = 'mira-external-query'
/** invoke: one chrome.runtime.sendMessage from a page. */
export const EXTERNAL_MESSAGE_CHANNEL = 'mira-external-message'
/** invoke: one chrome.runtime.connect from a page. */
export const EXTERNAL_CONNECT_CHANNEL = 'mira-external-connect'
/** send: port.postMessage from a page. */
export const EXTERNAL_PORT_POST_CHANNEL = 'mira-external-port-post'
/** send: port.disconnect from a page. */
export const EXTERNAL_PORT_DISCONNECT_CHANNEL = 'mira-external-port-disconnect'
/** main -> page: one event for one live port. */
export const EXTERNAL_PORT_EVENT_CHANNEL = 'mira-external-port-event'
/** main -> service worker: one WorkerEnvelope. */
export const EXTERNAL_WORKER_CHANNEL = 'mira-external-worker'
/** service worker -> main: one WorkerReply. */
export const EXTERNAL_WORKER_REPLY_CHANNEL = 'mira-external-worker-reply'

/** How long the worker half waits for the extension to register its listeners
 * before declaring "no receiver". A message can arrive while the worker script
 * is still evaluating (Mira starts workers itself, and a page can fire the
 * instant a tab opens); Chrome dispatches only once the worker is up, so an
 * immediate "receiving end does not exist" would be a Mira-only failure. */
const WORKER_LISTENER_GRACE_STEP_MS = 50
const WORKER_LISTENER_GRACE_STEPS = 40

/** Main-world half installed in a MATCHED web page. `bridge` is the isolated
 * world's ipc surface; nothing else crosses. Mirrors Chrome's web-page
 * chrome.runtime: sendMessage and connect require an explicit extension id,
 * lastError is set only for the duration of a callback, and a callback-less
 * sendMessage returns a promise. */
export const EXTERNAL_PAGE_MAIN_WORLD = `(bridge) => {
  var g = globalThis;
  if (!bridge || !g || typeof g !== 'object') return;
  try {
    if (!g.chrome) {
      Object.defineProperty(g, 'chrome', {
        value: {}, configurable: true, enumerable: true, writable: true
      });
    }
  } catch (_) { return; }
  var c = g.chrome;
  if (!c || c.__miraExternalMessaging) return;
  var runtime = (c.runtime && typeof c.runtime === 'object') ? c.runtime : {};
  var ID_REQUIRED = 'chrome.runtime.sendMessage() called from a webpage must ' +
    'specify an Extension ID (string) for its first argument.';
  var CONNECT_ID_REQUIRED = 'chrome.runtime.connect() called from a webpage must ' +
    'specify an Extension ID (string) for its first argument.';

  // lastError exists only while a callback runs, exactly as in Chrome.
  var withLastError = function (message, run) {
    if (message) { try { runtime.lastError = { message: message }; } catch (_) {} }
    try { run(); } finally {
      if (message) { try { delete runtime.lastError; } catch (_) {} }
    }
  };
  // Callback form only: the promise form is settled by the caller.
  var settle = function (result, callback) {
    withLastError(result.ok ? null : result.error, function () {
      callback(result.ok ? result.response : undefined);
    });
  };
  // A bad call still reaches a callback (with lastError) rather than throwing,
  // but throws when the page used the promise form — that is Chrome's split.
  var refuse = function (message, callback) {
    if (typeof callback !== 'function') throw new Error(message);
    Promise.resolve().then(function () { settle({ ok: false, error: message }, callback); });
    return undefined;
  };

  runtime.sendMessage = function (extensionId, message, options, callback) {
    var cb = typeof options === 'function' ? options : callback;
    if (typeof extensionId !== 'string' || extensionId === '') {
      return refuse(ID_REQUIRED, cb);
    }
    var request;
    try {
      request = bridge.sendMessage(extensionId, message);
    } catch (error) {
      return refuse(String(error && error.message || error), cb);
    }
    var done = Promise.resolve(request).then(function (result) {
      return result && typeof result === 'object' ? result : { ok: false, error: 'no response' };
    }, function (error) {
      return { ok: false, error: String(error && error.message || error) };
    });
    if (typeof cb === 'function') {
      done.then(function (result) { settle(result, cb); });
      return undefined;
    }
    return done.then(function (result) {
      if (result.ok) return result.response;
      throw new Error(result.error);
    });
  };

  var makeEvent = function (list) {
    return {
      addListener: function (fn) {
        if (typeof fn === 'function' && list.indexOf(fn) < 0) list.push(fn);
      },
      removeListener: function (fn) {
        var at = list.indexOf(fn);
        if (at >= 0) list.splice(at, 1);
      },
      hasListener: function (fn) { return list.indexOf(fn) >= 0; },
      hasListeners: function () { return list.length > 0; }
    };
  };

  runtime.connect = function (extensionId, connectInfo) {
    if (typeof extensionId !== 'string' || extensionId === '') {
      throw new Error(CONNECT_ID_REQUIRED);
    }
    var name = (connectInfo && typeof connectInfo.name === 'string') ? connectInfo.name : '';
    var messageListeners = [], disconnectListeners = [];
    var portId = null, closed = false, queued = [];
    var port = {
      name: name,
      onMessage: makeEvent(messageListeners),
      onDisconnect: makeEvent(disconnectListeners),
      postMessage: function (message) {
        if (closed) throw new Error('Attempting to use a disconnected port object');
        if (portId === null) { queued.push(message); return; }
        bridge.post(portId, message);
      },
      disconnect: function () {
        if (closed) return;
        closed = true; queued.length = 0;
        if (portId !== null) bridge.disconnect(portId);
      }
    };
    var close = function (error) {
      if (closed) return;
      closed = true; queued.length = 0;
      if (portId !== null) bridge.release(portId);
      var listeners = disconnectListeners.slice();
      withLastError(error, function () {
        for (var i = 0; i < listeners.length; i++) {
          try { listeners[i](port); } catch (_) {}
        }
      });
    };
    var onEvent = function (event) {
      if (!event || event.portId !== portId) return;
      if (event.type === 'disconnect') { close(event.error || null); return; }
      var listeners = messageListeners.slice();
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](event.message, port); } catch (_) {}
      }
    };
    Promise.resolve(bridge.connect(extensionId, name, onEvent)).then(function (result) {
      if (!result || !result.ok) { close((result && result.error) || 'connection failed'); return; }
      portId = result.portId;
      if (closed) { bridge.disconnect(portId); return; }
      for (var i = 0; i < queued.length; i++) bridge.post(portId, queued[i]);
      queued.length = 0;
    }, function (error) {
      close(String(error && error.message || error));
    });
    return port;
  };

  // Fill in the constants a real chrome.runtime carries, without clobbering the
  // ones stealth.ts may already have put there.
  if (!runtime.OnInstalledReason) {
    runtime.OnInstalledReason = {
      CHROME_UPDATE: 'chrome_update', INSTALL: 'install',
      SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update'
    };
  }
  if (!runtime.PlatformOs) {
    runtime.PlatformOs = {
      ANDROID: 'android', CROS: 'cros', LINUX: 'linux',
      MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win'
    };
  }
  // Chrome leaves runtime.id undefined on a web page (only extension contexts
  // have one), and pages test it — keep the property present and undefined.
  if (!('id' in runtime)) runtime.id = undefined;

  try {
    if (c.runtime !== runtime) {
      Object.defineProperty(c, 'runtime', {
        value: runtime, configurable: true, enumerable: true, writable: true
      });
    }
    Object.defineProperty(c, '__miraExternalMessaging', { value: true });
  } catch (_) { /* a locked-down chrome object: the methods above still stand */ }
}`

/** Frame preload (isolated world) for web pages. Asks main whether this frame
 * matches any extension and installs nothing when it doesn't — that gate is the
 * security barrier of the whole channel, so it runs before anything is built. */
export const EXTERNAL_PAGE_PRELOAD_SOURCE = `(function () {
  var electron;
  try { electron = require('electron'); } catch (_) { return; }
  var ipcRenderer = electron.ipcRenderer;
  var contextBridge = electron.contextBridge;
  if (!ipcRenderer) return;
  var href = '';
  try { href = String(location.href || ''); } catch (_) { return; }
  if (!/^https?:/i.test(href)) return;
  var matched = [];
  try { matched = ipcRenderer.sendSync(${JSON.stringify(EXTERNAL_QUERY_CHANNEL)}, href) || []; }
  catch (_) { return; }
  if (!matched.length) return;

  var portHandlers = Object.create(null);
  ipcRenderer.on(${JSON.stringify(EXTERNAL_PORT_EVENT_CHANNEL)}, function (_event, payload) {
    if (!payload) return;
    var handler = portHandlers[payload.portId];
    if (!handler) return;
    if (payload.type === 'disconnect') delete portHandlers[payload.portId];
    try { handler(payload); } catch (_) {}
  });

  var bridge = {
    sendMessage: function (extensionId, message) {
      return ipcRenderer.invoke(${JSON.stringify(EXTERNAL_MESSAGE_CHANNEL)}, {
        extensionId: extensionId, message: message
      });
    },
    connect: function (extensionId, name, onEvent) {
      return ipcRenderer.invoke(${JSON.stringify(EXTERNAL_CONNECT_CHANNEL)}, {
        extensionId: extensionId, name: name
      }).then(function (result) {
        if (result && result.ok) portHandlers[result.portId] = onEvent;
        return result;
      });
    },
    post: function (portId, message) {
      ipcRenderer.send(${JSON.stringify(EXTERNAL_PORT_POST_CHANNEL)}, {
        portId: portId, message: message
      });
    },
    disconnect: function (portId) {
      delete portHandlers[portId];
      ipcRenderer.send(${JSON.stringify(EXTERNAL_PORT_DISCONNECT_CHANNEL)}, { portId: portId });
    },
    release: function (portId) { delete portHandlers[portId]; }
  };

  var install = ${EXTERNAL_PAGE_MAIN_WORLD};
  try {
    if (contextBridge && typeof contextBridge.executeInMainWorld === 'function') {
      contextBridge.executeInMainWorld({ func: install, args: [bridge] });
      return;
    }
  } catch (_) { /* fall through */ }
  install(bridge);
})();
`

/** Main-world half installed in every extension service worker: the
 * onMessageExternal / onConnectExternal events Electron ships but never fires,
 * replaced by ones Mira actually delivers to. Response semantics follow Chrome:
 * a listener answers synchronously with sendResponse, or returns true (or a
 * promise) to answer later; if no listener does either, the channel closes and
 * the page sees "receiving end does not exist". */
export const EXTERNAL_WORKER_MAIN_WORLD = `(bridge) => {
  var g = globalThis;
  if (!bridge || !g.chrome || !g.chrome.runtime) return;
  if (g.__miraExternalMessagingWorker) return;
  try { Object.defineProperty(g, '__miraExternalMessagingWorker', { value: true }); }
  catch (_) { return; }

  var messageListeners = [], connectListeners = [];
  var makeEvent = function (list) {
    return {
      addListener: function (fn) {
        if (typeof fn === 'function' && list.indexOf(fn) < 0) list.push(fn);
      },
      removeListener: function (fn) {
        var at = list.indexOf(fn);
        if (at >= 0) list.splice(at, 1);
      },
      hasListener: function (fn) { return list.indexOf(fn) >= 0; },
      hasListeners: function () { return list.length > 0; }
    };
  };
  try {
    g.chrome.runtime.onMessageExternal = makeEvent(messageListeners);
    g.chrome.runtime.onConnectExternal = makeEvent(connectListeners);
  } catch (_) { return; }

  var GRACE_STEP = ${WORKER_LISTENER_GRACE_STEP_MS};
  var GRACE_STEPS = ${WORKER_LISTENER_GRACE_STEPS};
  var ports = Object.create(null);

  var deliverMessage = function (envelope, attempt) {
    if (!messageListeners.length) {
      if (attempt < GRACE_STEPS) {
        setTimeout(function () { deliverMessage(envelope, attempt + 1); }, GRACE_STEP);
        return;
      }
      bridge.reply({ kind: 'no-response', requestId: envelope.requestId });
      return;
    }
    var answered = false, async = false;
    var sendResponse = function (response) {
      if (answered) return;
      answered = true;
      bridge.reply({ kind: 'response', requestId: envelope.requestId, response: response });
    };
    var listeners = messageListeners.slice();
    for (var i = 0; i < listeners.length; i++) {
      var outcome;
      try { outcome = listeners[i](envelope.message, envelope.sender, sendResponse); }
      catch (_) { continue; }
      if (outcome === true) { async = true; }
      else if (outcome && typeof outcome.then === 'function') {
        async = true;
        outcome.then(sendResponse, function () { sendResponse(undefined); });
      }
    }
    if (!answered && !async) {
      bridge.reply({ kind: 'no-response', requestId: envelope.requestId });
    }
  };

  var makePort = function (portId, name, sender) {
    var messageL = [], disconnectL = [], closed = false;
    var port = {
      name: name,
      sender: sender,
      onMessage: makeEvent(messageL),
      onDisconnect: makeEvent(disconnectL),
      postMessage: function (message) {
        if (closed) throw new Error('Attempting to use a disconnected port object');
        bridge.reply({ kind: 'port-message', portId: portId, message: message });
      },
      disconnect: function () {
        if (closed) return;
        closed = true;
        delete ports[portId];
        bridge.reply({ kind: 'port-disconnect', portId: portId });
      }
    };
    return {
      port: port,
      deliver: function (message) {
        var listeners = messageL.slice();
        for (var i = 0; i < listeners.length; i++) {
          try { listeners[i](message, port); } catch (_) {}
        }
      },
      close: function () {
        if (closed) return;
        closed = true;
        delete ports[portId];
        var listeners = disconnectL.slice();
        for (var i = 0; i < listeners.length; i++) {
          try { listeners[i](port); } catch (_) {}
        }
      }
    };
  };

  var deliverConnect = function (envelope, attempt) {
    if (!connectListeners.length) {
      if (attempt < GRACE_STEPS) {
        setTimeout(function () { deliverConnect(envelope, attempt + 1); }, GRACE_STEP);
        return;
      }
      bridge.reply({ kind: 'port-disconnect', portId: envelope.portId });
      return;
    }
    var entry = makePort(envelope.portId, envelope.name || '', envelope.sender);
    ports[envelope.portId] = entry;
    var listeners = connectListeners.slice();
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](entry.port); } catch (_) {}
    }
  };

  bridge.register(function (envelope) {
    if (!envelope || typeof envelope !== 'object') return;
    switch (envelope.kind) {
      case 'message': deliverMessage(envelope, 0); return;
      case 'connect': deliverConnect(envelope, 0); return;
      case 'port-message': {
        var open = ports[envelope.portId];
        if (open) open.deliver(envelope.message);
        return;
      }
      case 'port-disconnect': {
        var closing = ports[envelope.portId];
        if (closing) closing.close();
        return;
      }
      default: return;
    }
  });
}`

/** Service-worker preload (isolated world): the ipc bridge for the half above.
 * Registered AFTER electron-chrome-extensions' own SW preload — see the file
 * header. */
export const EXTERNAL_WORKER_PRELOAD_SOURCE = `(function () {
  if (typeof process === 'undefined' || process.type !== 'service-worker') return;
  var electron;
  try { electron = require('electron'); } catch (_) { return; }
  var ipcRenderer = electron.ipcRenderer;
  var contextBridge = electron.contextBridge;
  if (!ipcRenderer) return;
  var handler = null;
  ipcRenderer.on(${JSON.stringify(EXTERNAL_WORKER_CHANNEL)}, function (_event, envelope) {
    if (!handler) return;
    try { handler(envelope); } catch (_) {}
  });
  var bridge = {
    register: function (fn) { if (typeof fn === 'function') handler = fn; },
    reply: function (payload) {
      try { ipcRenderer.send(${JSON.stringify(EXTERNAL_WORKER_REPLY_CHANNEL)}, payload); }
      catch (_) {}
    }
  };
  var install = ${EXTERNAL_WORKER_MAIN_WORLD};
  try {
    if (contextBridge && typeof contextBridge.executeInMainWorld === 'function') {
      contextBridge.executeInMainWorld({ func: install, args: [bridge] });
      return;
    }
  } catch (_) { /* fall through */ }
  install(bridge);
})();
`
