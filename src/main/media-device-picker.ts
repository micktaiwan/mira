// The camera/microphone device picker Mira shows on getUserMedia — Mira's answer
// to Chrome's "which camera / which mic?" permission bubble.
//
// Electron does NOT compile Chrome's native media picker, and unlike screen
// sharing (getDisplayMedia has setDisplayMediaRequestHandler, see
// extension-capture.ts) there is NO Electron hook to inject which device a
// getUserMedia call receives. So the choice is made in the page: a main-world
// shim (media-device-picker-shim.ts) intercepts getUserMedia, enumerates the
// devices, and asks THIS picker over IPC; the chosen deviceId is written back
// into the constraints before the real getUserMedia runs.
//
// This module is that picker window: a small modal listing the wanted device
// kinds (camera and/or mic) with a radio per device, Allow / Cancel. Split for
// testability (CLAUDE.md "tout testable"): the view model, the HTML, and the
// result parsing are pure functions; only showMediaDevicePicker touches Electron.

import { BrowserWindow, type IpcMainEvent } from 'electron'

/** One capture device as the picker renders it (a reduced MediaDeviceInfo). */
export interface MediaDevice {
  deviceId: string
  /** The OS label, e.g. "FaceTime HD Camera". May be '' if the page had no
   * permission yet; renderDevicePickerHtml falls back to "Camera N" / "Mic N". */
  label: string
  kind: 'videoinput' | 'audioinput'
}

/** What the shim asks the picker to resolve: which kinds the page wants, the
 * devices available for each, and the requesting origin (shown in the header). */
export interface MediaPickRequest {
  origin: string
  wantVideo: boolean
  wantAudio: boolean
  videoDevices: MediaDevice[]
  audioDevices: MediaDevice[]
}

/** The user's choice: the chosen deviceId per kind, or null for a kind the page
 * did not want / had no device for. The shim merges these into the constraints. */
export interface MediaPickChoice {
  video: string | null
  audio: string | null
}

/** The IPC channel the shim uses to request a pick (renderer/page -> main). */
export const MEDIA_PICK_IPC_CHANNEL = 'mira:media-device-pick'

/** The webContents-scoped channel the picker PAGE uses to report its result: a
 * JSON string of MediaPickChoice, or '' for cancel. Scoped to the picker
 * window, never a global ipcMain listener. */
export const DEVICE_PICKER_CHOOSE_CHANNEL = 'mira:media-picker:choose'

/** Preload for the picker window: one bridge letting the page report its choice.
 * Written to disk by the service and wired via webPreferences.preload. */
export const DEVICE_PICKER_PRELOAD_SOURCE = `const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('miraDevicePicker', {
  choose: (payload) => ipcRenderer.send(${JSON.stringify(DEVICE_PICKER_CHOOSE_CHANNEL)}, String(payload || '')),
})
`

/** Parse the string a picker page reports over DEVICE_PICKER_CHOOSE_CHANNEL into
 * a choice, or null for cancel ('' / unparseable / closed). Pure. */
export function parsePickResult(raw: unknown): MediaPickChoice | null {
  if (typeof raw !== 'string' || raw === '') return null
  let obj: { video?: unknown; audio?: unknown }
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const video = typeof obj.video === 'string' && obj.video ? obj.video : null
  const audio = typeof obj.audio === 'string' && obj.audio ? obj.audio : null
  // A pick that selected nothing at all is a cancel.
  if (video === null && audio === null) return null
  return { video, audio }
}

/** HTML-escape text before embedding it in the picker markup. Pure. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** A device's display name: its OS label, or a stable "Camera N" / "Microphone N"
 * fallback when the label is empty. Pure. */
export function deviceDisplayName(device: MediaDevice, index: number): string {
  if (device.label) return device.label
  const base = device.kind === 'videoinput' ? 'Camera' : 'Microphone'
  return `${base} ${index + 1}`
}

/** Render the picker page for a request. One column per WANTED kind that has at
 * least one device; a radio group per column, first device pre-selected. Allow
 * gathers the checked deviceId per kind and reports {video,audio} as JSON;
 * Cancel / Escape report ''. Pure — same request always yields the same HTML. */
export function renderDevicePickerHtml(req: MediaPickRequest): string {
  const column = (
    title: string,
    name: 'video' | 'audio',
    devices: MediaDevice[]
  ): string => {
    if (!devices.length) return ''
    const rows = devices
      .map((d, i) => {
        const label = escapeHtml(deviceDisplayName(d, i))
        return `<label class="row">
          <input type="radio" name="${name}" value="${escapeHtml(d.deviceId)}"${i === 0 ? ' checked' : ''} />
          <span class="dot"></span><span class="dname">${label}</span>
        </label>`
      })
      .join('')
    return `<section><h2 class="group-title">${title}</h2><div class="rows">${rows}</div></section>`
  }

  const videoCol = req.wantVideo ? column('Camera', 'video', req.videoDevices) : ''
  const audioCol = req.wantAudio ? column('Microphone', 'audio', req.audioDevices) : ''
  const nothing =
    !videoCol && !audioCol
      ? `<p class="empty">No camera or microphone is available. Check Camera &amp; Microphone access in System Settings &rsaquo; Privacy &amp; Security.</p>`
      : ''
  const origin = escapeHtml(req.origin || 'This site')

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font: 13px -apple-system, system-ui, sans-serif;
    background: #1e1e1e; color: #e8e8e8; user-select: none;
    display: flex; flex-direction: column; height: 100vh;
  }
  header { padding: 16px 20px 4px; }
  header h1 { margin: 0; font-size: 15px; font-weight: 600; }
  header .origin { color: #9a9a9a; font-size: 12px; margin-top: 2px; word-break: break-all; }
  main { flex: 1; overflow-y: auto; padding: 8px 20px 16px; display: flex; gap: 24px; }
  section { flex: 1; min-width: 0; }
  .group-title { font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
    color: #9a9a9a; margin: 12px 0 8px; }
  .rows { display: flex; flex-direction: column; gap: 4px; }
  .row { display: flex; align-items: center; gap: 8px; padding: 8px 10px;
    border-radius: 6px; cursor: pointer; transition: background .1s; }
  .row:hover { background: #2a2a2a; }
  .row input { position: absolute; opacity: 0; pointer-events: none; }
  .dot { width: 14px; height: 14px; flex: 0 0 auto; border-radius: 50%;
    border: 1.5px solid #6a6a6a; transition: border-color .1s, box-shadow .1s; }
  .row input:checked ~ .dot { border-color: #4c8bf5; box-shadow: inset 0 0 0 3px #4c8bf5; }
  .row:has(input:checked) { background: #2f3947; }
  .dname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { color: #9a9a9a; line-height: 1.5; }
  footer { padding: 12px 20px; border-top: 1px solid #333; display: flex;
    justify-content: flex-end; gap: 8px; }
  button { border: none; border-radius: 6px; padding: 7px 16px; font: inherit; cursor: pointer; }
  .cancel { background: #3a3a3a; color: #e8e8e8; }
  .cancel:hover { background: #454545; }
  .allow { background: #4c8bf5; color: #fff; }
  .allow:hover { background: #5a95f6; }
  .allow:disabled { background: #333; color: #777; cursor: default; }
</style>
</head>
<body>
  <header>
    <h1>Share camera &amp; microphone</h1>
    <div class="origin">${origin}</div>
  </header>
  <main>${videoCol}${audioCol}${nothing}</main>
  <footer>
    <button class="cancel" type="button" onclick="cancel()">Cancel</button>
    <button class="allow" type="button" onclick="allow()"${nothing ? ' disabled' : ''}>Allow</button>
  </footer>
  <script>
    function pick(name) {
      var el = document.querySelector('input[name="' + name + '"]:checked');
      return el ? el.value : null;
    }
    function allow() {
      miraDevicePicker.choose(JSON.stringify({ video: pick('video'), audio: pick('audio') }));
    }
    function cancel() { miraDevicePicker.choose(''); }
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') cancel();
      else if (e.key === 'Enter') allow();
    });
  </script>
</body>
</html>`
}

/** Options showMediaDevicePicker needs beyond the request. */
export interface MediaPickerOptions {
  /** Window to parent/anchor the modal to, or null for standalone. */
  parent: BrowserWindow | null
  /** On-disk path of DEVICE_PICKER_PRELOAD_SOURCE (the service writes it). */
  preloadPath: string
}

/** Show the modal picker and resolve with the choice, or null on cancel/close.
 * The only impure part of this module. */
export function showMediaDevicePicker(
  req: MediaPickRequest,
  opts: MediaPickerOptions
): Promise<MediaPickChoice | null> {
  const win = new BrowserWindow({
    parent: opts.parent ?? undefined,
    modal: opts.parent != null,
    width: 520,
    height: 420,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Share camera & microphone',
    backgroundColor: '#1e1e1e',
    show: false,
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.setMenuBarVisibility(false)

  return new Promise<MediaPickChoice | null>((resolve) => {
    let settled = false
    const finish = (value: MediaPickChoice | null): void => {
      if (settled) return
      settled = true
      resolve(value)
      if (!win.isDestroyed()) win.close()
    }
    win.webContents.ipc.on(DEVICE_PICKER_CHOOSE_CHANNEL, (_event: IpcMainEvent, raw: string) => {
      finish(parsePickResult(raw))
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.once('ready-to-show', () => win.show())
    // A closed window with nothing picked is a cancel.
    win.on('closed', () => {
      if (!settled) {
        settled = true
        resolve(null)
      }
    })
    win
      .loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(renderDevicePickerHtml(req)))
      .catch(() => finish(null))
  })
}
