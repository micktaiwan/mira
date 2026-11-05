// Wires the camera/mic picker onto web-page sessions: registers the getUserMedia
// shim as a frame preload (so every page's getUserMedia routes through it) and
// installs the ipcMain handler that shows the native picker when the shim asks.
//
// Same shape as ExtensionCaptureService: pure decisions and rendering live in
// media-device-picker.ts / media-device-picker-shim.ts; this class is the thin
// Electron wiring (on-disk preload, session registration, one global ipc handler).

import { BrowserWindow, ipcMain, type Session } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  DEVICE_PICKER_PRELOAD_SOURCE,
  MEDIA_PICK_IPC_CHANNEL,
  showMediaDevicePicker,
  type MediaDevice,
  type MediaPickChoice,
  type MediaPickRequest
} from './media-device-picker'
import { hostMatchesDomain } from './domain'
import {
  GUM_SHIM_PRELOAD_SOURCE,
  MEDIA_PICK_SKIP_IPC_CHANNEL,
  skipsDevicePicker
} from './media-device-picker-shim'

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

/** One profile's hosts where the camera patch stays off. This reveals where the user
 * went, so it follows the rules of browsing history: on disk in that profile's folder
 * only, never shared across profiles, wiped by forget-domain and clear-history.
 *
 * Stateless on purpose: every call reads the file. It works on a profile that is not
 * open, and no cached list can write a wiped host back or recreate the folder of a
 * deleted or locked profile. Only learn and ruleOut may create the file: a page still
 * open after a wipe that freezes again is recorded again, like a new history visit. */
export class PickerSkipStore {
  constructor(private readonly dir: string) {}

  private get file(): string {
    return join(this.dir, 'media-picker-skip-hosts.json')
  }

  list(): { learned: string[]; ruledOut: string[] } {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as {
        learned?: unknown
        ruledOut?: unknown
      }
      const hosts = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((h) => typeof h === 'string') : []
      return { learned: hosts(raw.learned), ruledOut: hosts(raw.ruledOut) }
    } catch {
      return { learned: [], ruledOut: [] }
    }
  }

  private write(lists: { learned: string[]; ruledOut: string[] }): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.file, JSON.stringify(lists, null, 2), 'utf8')
  }

  /** Remove hosts, without creating anything when there is no file. */
  private remove(drop: (host: string) => boolean): void {
    if (!existsSync(this.file)) return
    const { learned, ruledOut } = this.list()
    this.write({
      learned: learned.filter((h) => !drop(h)),
      ruledOut: ruledOut.filter((h) => !drop(h))
    })
  }

  isSkipped(host: string): boolean {
    return skipsDevicePicker(host, this.list().learned)
  }

  isRuledOut(host: string): boolean {
    return this.list().ruledOut.includes(host)
  }

  learn(host: string): void {
    const { learned, ruledOut } = this.list()
    this.write({ learned: [...new Set([...learned, host])], ruledOut })
  }

  ruleOut(host: string): void {
    const { learned, ruledOut } = this.list()
    this.write({
      learned: learned.filter((h) => h !== host),
      ruledOut: [...new Set([...ruledOut, host])]
    })
  }

  /** Give a host its picker back, and let the watchdog suspect it again. */
  forget(host: string): void {
    this.remove((h) => h === host)
  }

  /** Drop every host of a registrable domain (the forget-site wipe). */
  forgetDomain(domain: string): void {
    this.remove((h) => hostMatchesDomain(h, domain))
  }

  clear(): void {
    this.remove(() => true)
  }
}

/** The store of one profile, opened or not. */
export function pickerSkipsFor(userDataDir: string, profileId: string): PickerSkipStore {
  return new PickerSkipStore(join(userDataDir, 'profiles', profileId))
}

export class MediaDevicePickerService {
  private shimPreloadPath: string | null = null
  private pickerPreloadPath: string | null = null
  private ipcInstalled = false
  /** One picker at a time — a second request while one is up is denied (cancel),
   * mirroring ExtensionCaptureService.pickerOpen. */
  private pickerOpen = false
  private readonly attached = new WeakSet<Session>()
  private readonly skipsBySession = new WeakMap<Session, PickerSkipStore>()

  constructor(private readonly userDataDir: string) {}

  /** Install the ipc handler (once) and register the shim preload on `ses`
   * (once per session). Call for each web-page session. */
  attach(ses: Session, profileId: string): void {
    this.installIpc()
    if (this.attached.has(ses)) return
    this.attached.add(ses)
    this.skipsBySession.set(ses, pickerSkipsFor(this.userDataDir, profileId))
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
    ipcMain.on(MEDIA_PICK_SKIP_IPC_CHANNEL, (event, hostname) => {
      // The top frame counts too: an about:blank or third-party frame under a skipped
      // page must not bring the patch back into that page.
      let top = ''
      try {
        top = new URL(event.senderFrame?.top?.url ?? '').hostname
      } catch {
        /* no top url yet */
      }
      const skips = this.skipsBySession.get(event.sender.session)
      event.returnValue =
        !!skips &&
        ((typeof hostname === 'string' && skips.isSkipped(hostname)) ||
          (!!top && skips.isSkipped(top)))
    })
  }

  skipsForSession(ses: Session): PickerSkipStore | null {
    return this.skipsBySession.get(ses) ?? null
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
