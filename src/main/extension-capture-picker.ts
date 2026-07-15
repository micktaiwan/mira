// The desktop-source picker Mira shows for chrome.desktopCapture.chooseDesktopMedia.
//
// chooseDesktopMedia is a BROWSER responsibility: the extension (Claap et al.)
// only calls it and receives a streamId — Chrome draws the picker. Mira has no
// native Chromium picker, so this module IS that picker: a small modal window
// listing desktopCapturer sources (screens + windows) with thumbnails; the user
// clicks one and its source id flows back to the capture backend.
//
// Split for testability (CLAUDE.md "tout testable"): the view-model shaping and
// the HTML are pure functions; only showDesktopSourcePicker touches Electron.

import { BrowserWindow, type IpcMainEvent } from 'electron'

/** A desktop source reduced to what the picker renders. Thumbnails/icons are
 * data: URLs so the HTML is self-contained (no crx:/file: fetch). */
export interface PickerSource {
  id: string
  name: string
  kind: 'screen' | 'window'
  /** PNG data URL of the source preview, or '' when unavailable. */
  thumbnail: string
  /** PNG data URL of the owning app icon (windows only), or null. */
  appIcon: string | null
}

/** desktopCapturer screen ids look like "screen:0:0"; everything else is a
 * window ("window:1234:0"). Pure. */
export function pickerKind(id: string): 'screen' | 'window' {
  return id.startsWith('screen:') ? 'screen' : 'window'
}

/** HTML-escape a source name before embedding it in the picker markup. Pure. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** The IPC channel the picker page uses to report the chosen source id (or ''
 * for cancel). Scoped to the picker window's webContents, never global. */
export const PICKER_CHOOSE_CHANNEL = 'mira:desktop-picker:choose'

/** The preload for the picker window: a single bridge that lets the page report
 * the clicked source id. Written to disk by the capture service (same pattern
 * as the capture frame shim) and wired via webPreferences.preload. */
export const PICKER_PRELOAD_SOURCE = `const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('miraPicker', {
  choose: (id) => ipcRenderer.send(${JSON.stringify(PICKER_CHOOSE_CHANNEL)}, String(id || '')),
})
`

/** Render the full picker page for `sources`. Screens first, then windows, each
 * a clickable card; clicking calls window.miraPicker.choose(id) (exposed by the
 * preload). A Cancel button reports ''. Pure — given the same sources it always
 * returns the same HTML, so it is unit-tested directly. */
export function renderPickerHtml(sources: readonly PickerSource[]): string {
  const screens = sources.filter((s) => s.kind === 'screen')
  const windows = sources.filter((s) => s.kind === 'window')

  const card = (s: PickerSource): string => {
    const thumb = s.thumbnail
      ? `<img class="thumb" src="${s.thumbnail}" alt="" draggable="false" />`
      : `<div class="thumb thumb-empty"></div>`
    const icon = s.appIcon ? `<img class="app-icon" src="${s.appIcon}" alt="" />` : ''
    return `<button class="card" type="button" onclick="miraPicker.choose('${escapeHtml(s.id)}')" title="${escapeHtml(s.name)}">
      ${thumb}
      <span class="label">${icon}<span class="name">${escapeHtml(s.name)}</span></span>
    </button>`
  }

  const group = (title: string, items: PickerSource[]): string =>
    items.length
      ? `<h2 class="group-title">${title}</h2><div class="grid">${items.map(card).join('')}</div>`
      : ''

  const empty = sources.length
    ? ''
    : `<p class="empty">No screen or window is available to share. Check Screen Recording permission in System Settings &rsaquo; Privacy &amp; Security.</p>`

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font: 13px -apple-system, system-ui, sans-serif;
    background: #1e1e1e; color: #e8e8e8; user-select: none;
    display: flex; flex-direction: column; height: 100vh;
  }
  header { padding: 16px 20px 8px; }
  header h1 { margin: 0; font-size: 15px; font-weight: 600; }
  main { flex: 1; overflow-y: auto; padding: 8px 20px 16px; }
  .group-title { font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
    color: #9a9a9a; margin: 16px 0 8px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
  .card { background: #2a2a2a; border: 1px solid transparent; border-radius: 8px;
    padding: 8px; cursor: pointer; color: inherit; text-align: left; font: inherit;
    display: flex; flex-direction: column; gap: 8px; transition: border-color .1s, background .1s; }
  .card:hover { background: #333; border-color: #4c8bf5; }
  .card:focus-visible { outline: 2px solid #4c8bf5; outline-offset: 1px; }
  .thumb { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 4px;
    background: #111; display: block; }
  .thumb-empty { background: repeating-linear-gradient(45deg, #222, #222 6px, #262626 6px, #262626 12px); }
  .label { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .app-icon { width: 16px; height: 16px; flex: 0 0 auto; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { color: #9a9a9a; line-height: 1.5; }
  footer { padding: 12px 20px; border-top: 1px solid #333; display: flex; justify-content: flex-end; }
  .cancel { background: #3a3a3a; color: #e8e8e8; border: none; border-radius: 6px;
    padding: 7px 16px; font: inherit; cursor: pointer; }
  .cancel:hover { background: #454545; }
</style>
</head>
<body>
  <header><h1>Choose what to share</h1></header>
  <main>${group('Screens', screens)}${group('Windows', windows)}${empty}</main>
  <footer><button class="cancel" type="button" onclick="miraPicker.choose('')">Cancel</button></footer>
  <script>
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') miraPicker.choose(''); });
  </script>
</body>
</html>`
}

/** Options the native picker needs beyond the sources. */
export interface DesktopPickerOptions {
  /** Window to parent/anchor the modal to, or null for a standalone window. */
  parent: BrowserWindow | null
  /** On-disk path of PICKER_PRELOAD_SOURCE (the capture service writes it). */
  preloadPath: string
}

/** Show the modal picker and resolve with the chosen source id, or null when
 * the user cancels / closes it. The only impure part of this module. */
export function showDesktopSourcePicker(
  sources: readonly PickerSource[],
  opts: DesktopPickerOptions
): Promise<string | null> {
  const win = new BrowserWindow({
    parent: opts.parent ?? undefined,
    modal: opts.parent != null,
    width: 780,
    height: 580,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Choose what to share',
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

  return new Promise<string | null>((resolve) => {
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      resolve(value)
      if (!win.isDestroyed()) win.close()
    }
    // The page reports the clicked id ('' = cancel) over a webContents-scoped
    // channel, so there is no global ipcMain listener to clean up.
    win.webContents.ipc.on(PICKER_CHOOSE_CHANNEL, (_event: IpcMainEvent, id: string) => {
      finish(id ? id : null)
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
      .loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(renderPickerHtml(sources)))
      .catch(() => finish(null))
  })
}
