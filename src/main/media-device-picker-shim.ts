// The page-side half of the camera/mic picker: a main-world shim that wraps
// navigator.mediaDevices.getUserMedia so every call routes through Mira's native
// device picker (media-device-picker.ts) before the real capture starts.
//
// Why in the page: Electron gives NO hook to pick which device a getUserMedia
// call receives (unlike getDisplayMedia). So we intercept the call in the page's
// MAIN world, enumerate devices there, ask main for a choice over IPC, and
// rewrite the constraints with the chosen deviceId. Same injection idiom as the
// capture shim (extension-capabilities.ts): a frame PRELOAD builds an ipc bridge
// and crosses it into the main world via contextBridge.executeInMainWorld.
//
// The Electron/string glue is thin; the decisions are the two pure helpers below
// (parseMediaWants, applyChosenDevices), which the unit tests pin — the main-world
// string mirrors applyChosenDevices exactly.

import type { MediaPickChoice } from './media-device-picker'
import { MEDIA_PICK_IPC_CHANNEL } from './media-device-picker'

/** Which kinds a getUserMedia constraints object asks for. A MediaStream
 * constraint is "wanted" when its value is truthy (true or a constraints
 * object); false / undefined means the kind is not requested. Pure. */
export function parseMediaWants(constraints: unknown): {
  wantVideo: boolean
  wantAudio: boolean
} {
  const c = (constraints ?? {}) as { video?: unknown; audio?: unknown }
  return { wantVideo: !!c.video, wantAudio: !!c.audio }
}

/** Merge a chosen deviceId into one kind's constraint value. `true` becomes
 * `{ deviceId: { exact } }`; an existing constraints object keeps its fields and
 * gains the exact deviceId. `exact` pins the user's choice so Chromium cannot
 * silently fall back to another camera. Pure. */
function withDeviceId(value: unknown, deviceId: string): MediaTrackConstraints {
  const base: MediaTrackConstraints =
    value && typeof value === 'object' ? { ...(value as MediaTrackConstraints) } : {}
  base.deviceId = { exact: deviceId }
  return base
}

/** Apply the user's pick to the original constraints, returning a NEW object.
 * A kind is rewritten only when it was wanted AND the pick has a deviceId for it;
 * otherwise its original value is kept untouched (so a kind with no available
 * device just falls back to the default). Pure — the spec the shim string obeys. */
export function applyChosenDevices(
  constraints: unknown,
  choice: MediaPickChoice
): MediaStreamConstraints {
  const c = (constraints ?? {}) as MediaStreamConstraints
  const { wantVideo, wantAudio } = parseMediaWants(c)
  const next: MediaStreamConstraints = { ...c }
  if (wantVideo && choice.video) next.video = withDeviceId(c.video, choice.video)
  if (wantAudio && choice.audio) next.audio = withDeviceId(c.audio, choice.audio)
  return next
}

/** Main-world install function (as a string): patches getUserMedia to route
 * through the picker. `bridge.pickDevices(request)` resolves to a MediaPickChoice
 * or null (cancel). Cancel throws NotAllowedError — exactly what a page gets when
 * the user clicks Block in Chrome. An IPC failure falls back to the real call so
 * a broken picker never blocks capture. Guarded against double-install and
 * wrapped so it can never break the page. Mirrors applyChosenDevices. */
export const GUM_SHIM_MAIN_WORLD = `(bridge) => {
  var md = navigator.mediaDevices;
  if (!md || typeof md.getUserMedia !== 'function' || md.__miraPicker || !bridge) return;
  md.__miraPicker = true;
  var orig = md.getUserMedia.bind(md);
  var withDeviceId = function (value, id) {
    var base = value && typeof value === 'object' ? Object.assign({}, value) : {};
    base.deviceId = { exact: id };
    return base;
  };
  md.getUserMedia = function (constraints) {
    try {
      var c = constraints || {};
      var wantVideo = !!c.video, wantAudio = !!c.audio;
      if (!wantVideo && !wantAudio) return orig(constraints);
      return md.enumerateDevices().then(function (devices) {
        var reduce = function (kind) {
          return devices.filter(function (d) { return d.kind === kind; })
            .map(function (d) { return { deviceId: d.deviceId, label: d.label, kind: d.kind }; });
        };
        var request = {
          origin: location.origin,
          wantVideo: wantVideo, wantAudio: wantAudio,
          videoDevices: reduce('videoinput'),
          audioDevices: reduce('audioinput')
        };
        return Promise.resolve(bridge.pickDevices(request)).then(function (choice) {
          if (!choice) throw new DOMException('Permission denied by user', 'NotAllowedError');
          var next = Object.assign({}, c);
          if (wantVideo && choice.video) next.video = withDeviceId(c.video, choice.video);
          if (wantAudio && choice.audio) next.audio = withDeviceId(c.audio, choice.audio);
          return orig(next);
        }, function (err) {
          // IPC/bridge failure (NOT a user cancel) — do not block the user.
          if (err && err.name === 'NotAllowedError') throw err;
          return orig(constraints);
        });
      }, function () { return orig(constraints); });
    } catch (e) {
      return orig(constraints);
    }
  };
}`

/** Frame preload (isolated world): build the ipc bridge and cross it into the
 * page's main world to run GUM_SHIM_MAIN_WORLD. executeInMainWorld is the
 * documented boundary crosser (same as the capture shim); the fallback runs the
 * installer directly for older Electron. */
export const GUM_SHIM_PRELOAD_SOURCE = `(function () {
  var electron = require('electron');
  var contextBridge = electron.contextBridge;
  var ipcRenderer = electron.ipcRenderer;
  if (!ipcRenderer) return;
  var CHANNEL = ${JSON.stringify(MEDIA_PICK_IPC_CHANNEL)};
  var bridge = {
    pickDevices: function (request) { return ipcRenderer.invoke(CHANNEL, request); }
  };
  var install = ${GUM_SHIM_MAIN_WORLD};
  try {
    if (contextBridge && typeof contextBridge.executeInMainWorld === 'function') {
      contextBridge.executeInMainWorld({ func: install, args: [bridge] });
      return;
    }
  } catch (_) { /* fall through */ }
  install(bridge);
})();
`
