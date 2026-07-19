// Wires the camera/mic picker onto web-page sessions: registers the getUserMedia
// shim as a frame preload (so every page's getUserMedia routes through it) and
// installs the ipcMain handler that shows the native picker when the shim asks.
//
// Same shape as ExtensionCaptureService: pure decisions and rendering live in
// media-device-picker.ts / media-device-picker-shim.ts; this class is the thin
// Electron wiring (on-disk preload, session registration, one global ipc handler).

import { BrowserWindow, ipcMain, type Session } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  DEVICE_PICKER_PRELOAD_SOURCE,
  MEDIA_PICK_IPC_CHANNEL,
  showMediaDevicePicker,
  type MediaDevice,
  type MediaPickChoice,
  type MediaPickRequest
} from './media-device-picker'
import { GUM_SHIM_PRELOAD_SOURCE } from './media-device-picker-shim'

/** Coerce the untrusted IPC payload (it crosses from a web page's main world)
 * into a MediaPickRequest, dropping anything malformed. Pure. */
export function normalizePickRequest(payload: unknown): MediaPickRequest {
  const p = (payload ?? {}) as Partial<MediaPickRequest>
  const devices = (raw: unknown, kind: MediaDevice['kind']): MediaDevice[] =>
    Array.isArray(raw)
      ? raw
          .map((d) => d as Partial<MediaDevice>)
          .filter((d) => d && typeof d.deviceId === 'string' && d.deviceId)
          .map((d) => ({ deviceId: d.deviceId as string, label: String(d.label ?? ''), kind }))
      : []
  return {
    origin: typeof p.origin === 'string' ? p.origin : '',
    wantVideo: !!p.wantVideo,
    wantAudio: !!p.wantAudio,
    videoDevices: devices(p.videoDevices, 'videoinput'),
    audioDevices: devices(p.audioDevices, 'audioinput')
  }
}

export class MediaDevicePickerService {
  private shimPreloadPath: string | null = null
  private pickerPreloadPath: string | null = null
  private ipcInstalled = false
  /** One picker at a time — a second request while one is up is denied (cancel),
   * mirroring ExtensionCaptureService.pickerOpen. */
  private pickerOpen = false
  private readonly attached = new WeakSet<Session>()

  constructor(private readonly userDataDir: string) {}

  /** Install the ipc handler (once) and register the shim preload on `ses`
   * (once per session). Call for each web-page session. */
  attach(ses: Session): void {
    this.installIpc()
    if (this.attached.has(ses)) return
    this.attached.add(ses)
    ses.registerPreloadScript({
      id: 'mira-media-device-picker',
      type: 'frame',
      filePath: this.ensureShimPreload()
    })
  }

  private installIpc(): void {
    if (this.ipcInstalled) return
    this.ipcInstalled = true
    ipcMain.handle(MEDIA_PICK_IPC_CHANNEL, (_event, payload) => this.pick(payload))
  }

  /** Show the picker for one getUserMedia request and resolve the choice, or null
   * to cancel (a picker already up, or nothing to pick). */
  private async pick(payload: unknown): Promise<MediaPickChoice | null> {
    if (this.pickerOpen) return null
    const request = normalizePickRequest(payload)
    const hasVideo = request.wantVideo && request.videoDevices.length > 0
    const hasAudio = request.wantAudio && request.audioDevices.length > 0
    // Nothing to choose from — let the real getUserMedia proceed with defaults
    // (returning a non-null empty choice would rewrite nothing anyway, but the
    // shim treats null as cancel, so signal "no devices" by an empty allow).
    if (!hasVideo && !hasAudio) return { video: null, audio: null }
    this.pickerOpen = true
    try {
      return await showMediaDevicePicker(request, {
        parent: BrowserWindow.getFocusedWindow(),
        preloadPath: this.ensurePickerPreload()
      })
    } finally {
      this.pickerOpen = false
    }
  }

  private ensureShimPreload(): string {
    return (this.shimPreloadPath ??= this.writeShim(
      'media-device-picker-shim.js',
      GUM_SHIM_PRELOAD_SOURCE
    ))
  }

  private ensurePickerPreload(): string {
    return (this.pickerPreloadPath ??= this.writeShim(
      'media-device-picker-preload.js',
      DEVICE_PICKER_PRELOAD_SOURCE
    ))
  }

  private writeShim(name: string, source: string): string {
    const dir = join(this.userDataDir, 'sw-shims')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const path = join(dir, name)
    writeFileSync(path, source, 'utf8')
    return path
  }
}
