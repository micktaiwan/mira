// chrome.desktopCapture / chrome.tabCapture for extension pages.
//
// Electron does not compile either API (their manifest permissions come back
// "unknown"), but a meeting recorder like Claap is built on them: its recorder
// page calls chrome.desktopCapture.chooseDesktopMedia and feeds the returned
// stream id to getUserMedia({chromeMediaSource:'desktop', chromeMediaSourceId})
// — which IS Electron's documented desktopCapturer flow — and its audio-only
// mode goes through chrome.tabCapture.capture. The page-side shims live in
// extension-capabilities.ts (CAPTURE_SHIM_FRAME_SOURCE, main-world, extension
// pages only); this service is their main-process backend:
//
//   - chooseDesktopMedia -> desktopCapturer.getSources + a Mira-drawn picker
//     modal (extension-capture-picker.ts). chooseDesktopMedia is a browser
//     responsibility (Chrome shows its own picker and returns a streamId); Mira
//     is the browser here, so it must draw the source chooser itself. The user
//     picks a screen/window and its id becomes the streamId; cancel returns ''.
//   - tabCapture.capture -> the shim arms this service for its frame, then
//     calls getDisplayMedia; the session's display-media handler resolves the
//     armed request to the ACTIVE TAB's main frame — video AND audio (Electron
//     captures a WebFrameMain's audio on macOS, unlike system loopback).
//     Unarmed getDisplayMedia requests are denied, which is what they got
//     before this handler existed.

import {
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  type DesktopCapturerSource,
  type IpcMainInvokeEvent,
  type Session,
  type WebContents
} from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  BEGIN_TAB_CAPTURE_IPC_CHANNEL,
  CAPTURE_SHIM_FRAME_SOURCE,
  CHOOSE_DESKTOP_MEDIA_IPC_CHANNEL
} from './extension-capabilities'
import {
  PICKER_PRELOAD_SOURCE,
  pickerKind,
  showDesktopSourcePicker,
  type PickerSource
} from './extension-capture-picker'

/** The resolve callback Electron hands to setDisplayMediaRequestHandler. */
type DisplayMediaCallback = Parameters<
  NonNullable<Parameters<Session['setDisplayMediaRequestHandler']>[0]>
>[1]

/** A desktop source reduced to what selection needs. */
export interface DesktopSourceLike {
  id: string
  name: string
}

/** Electron's desktopCapturer types for a Chrome chooseDesktopMedia source
 * list. Chrome's 'tab' has no Electron equivalent (no per-tab desktop source)
 * and 'audio' is not a source type — both map to nothing; an empty request
 * falls back to screen+window rather than failing. Pure. */
export function desktopSourceTypes(wanted: readonly string[]): ('screen' | 'window')[] {
  const types = new Set<'screen' | 'window'>()
  for (const source of wanted) {
    if (source === 'screen') types.add('screen')
    if (source === 'window') types.add('window')
  }
  return types.size ? [...types] : ['screen', 'window']
}

/** Auto-select the source chooseDesktopMedia returns: the first screen when
 * any is available (ids look like screen:x:y), else the first window, else
 * null. Pure. */
export function pickDesktopSource(sources: readonly DesktopSourceLike[]): DesktopSourceLike | null {
  const screen = sources.find((s) => s.id.startsWith('screen:'))
  return screen ?? sources[0] ?? null
}

/** How long an armed tab capture stays valid. getDisplayMedia follows the
 * arming ipc round-trip within milliseconds; 10s absorbs a slow renderer
 * without leaving a stale grant around. */
export const TAB_CAPTURE_ARM_TTL_MS = 10_000

/** Arm bookkeeping: one armed request per frame, single-use, TTL-bound.
 * Pure decisions over a plain map so they are testable. */
export function armFrame(pending: Map<string, number>, frameKey: string, nowMs: number): void {
  pending.set(frameKey, nowMs + TAB_CAPTURE_ARM_TTL_MS)
}

/** Consume an armed request for `frameKey`, expiring stale entries. */
export function consumeArmedFrame(
  pending: Map<string, number>,
  frameKey: string,
  nowMs: number
): boolean {
  const deadline = pending.get(frameKey)
  if (deadline === undefined) return false
  pending.delete(frameKey)
  return nowMs <= deadline
}

/** Hooks the capture backend needs from the profile world. */
export interface CaptureHooks {
  /** The active tab's webContents of the profile window, or null. */
  activeTab: () => WebContents | null
}

export class ExtensionCaptureService {
  /** Armed tab-capture requests, keyed by frame (processId:routingId). */
  private readonly pendingTabCapture = new Map<string, number>()
  /** Sessions whose display-media handler + preload are installed. */
  private readonly attached = new WeakSet<Session>()
  /** Global ipcMain handlers installed once. */
  private ipcInstalled = false
  /** On-disk frame preload, written once. */
  private shimPath: string | null = null
  /** On-disk picker-window preload, written once. */
  private pickerPreloadPath: string | null = null
  /** True while a desktop-source picker is open, so a second chooseDesktopMedia
   * cannot stack a second modal. */
  private pickerOpen = false

  constructor(private readonly userDataDir: string) {}

  /** Wire the capture shims into `ses`. Must run BEFORE the extensions lib
   * registers its preloads (same Object.freeze(chrome) ordering constraint as
   * every main-world shim). Idempotent per session; best-effort. */
  attach(ses: Session, hooks: CaptureHooks): void {
    if (this.attached.has(ses)) return
    this.attached.add(ses)
    try {
      this.registerPreload(ses)
    } catch (error) {
      console.warn('[mira] failed to register capture shim preload:', error)
    }
    this.installIpc()
    ses.setDisplayMediaRequestHandler((request, callback) => {
      const frame = request.frame
      const armed =
        frame !== null &&
        consumeArmedFrame(
          this.pendingTabCapture,
          frameKey(frame.processId, frame.routingId),
          Date.now()
        )
      const target = armed ? hooks.activeTab() : null
      if (target && !target.isDestroyed()) {
        // Tab capture: video + audio of the active tab. enableLocalEcho keeps
        // the tab audible while it is being recorded.
        callback({ video: target.mainFrame, audio: target.mainFrame, enableLocalEcho: true })
        return
      }
      // A normal web page called getDisplayMedia (screen share on Meet, Slack
      // huddles, etc.). Mira is the browser here, so it draws the desktop-source
      // picker and hands back the chosen screen/window. Async: the callback is
      // resolved once the user picks (or cancels).
      void this.chooseDesktopForPage(callback)
    })
  }

  /** The two page->main channels, once per app (ipcMain is global). Senders
   * are validated to extension pages whose manifest declares the matching
   * permission ('desktopCapture' / 'tabCapture', as Chrome requires) — a web
   * page, or an extension without the permission, gets an error, not a
   * capture. */
  private installIpc(): void {
    if (this.ipcInstalled) return
    this.ipcInstalled = true
    ipcMain.handle(
      CHOOSE_DESKTOP_MEDIA_IPC_CHANNEL,
      async (event, payload: { sources?: unknown }) => {
        if (!senderMayCapture(event, 'desktopCapture')) return { streamId: '' }
        const wanted = Array.isArray(payload?.sources)
          ? payload.sources.filter((s): s is string => typeof s === 'string')
          : []
        // One picker at a time: a second chooseDesktopMedia while the modal is
        // up is treated as a cancel rather than stacking a window.
        if (this.pickerOpen) return { streamId: '' }
        try {
          const sources = await desktopCapturer.getSources({
            types: desktopSourceTypes(wanted),
            thumbnailSize: { width: 320, height: 180 },
            fetchWindowIcons: true
          })
          const streamId = await this.chooseSource(sources)
          if (!streamId)
            console.warn('[mira-capture] no desktop source chosen (cancelled or none available)')
          return { streamId }
        } catch (error) {
          console.warn('[mira-capture] getSources failed:', error)
          return { streamId: '' }
        }
      }
    )
    ipcMain.handle(BEGIN_TAB_CAPTURE_IPC_CHANNEL, (event) => {
      if (!senderMayCapture(event, 'tabCapture'))
        return { ok: false, error: 'extension lacks the "tabCapture" permission' }
      const frame = event.senderFrame
      if (!frame) return { ok: false, error: 'no sender frame' }
      armFrame(this.pendingTabCapture, frameKey(frame.processId, frame.routingId), Date.now())
      return { ok: true }
    })
  }

  /** Backend for a plain web page's getDisplayMedia (Meet, Slack huddles…):
   * enumerate desktop sources, let the user pick one through Mira's own picker,
   * and resolve the request with the chosen screen/window. Cancel, an empty
   * source list, or a picker already up all resolve to a denied request
   * (callback({})) — the same outcome the page would get if it clicked Cancel in
   * Chrome. Video-only: system-audio loopback is not offered for screen shares
   * (Meet mixes mic audio itself). */
  private async chooseDesktopForPage(callback: DisplayMediaCallback): Promise<void> {
    if (this.pickerOpen) return callback({})
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: true
      })
      const streamId = await this.chooseSource(sources)
      const chosen = streamId ? sources.find((s) => s.id === streamId) : undefined
      if (!chosen) {
        console.warn('[mira-capture] getDisplayMedia: no source chosen (cancelled or none)')
        return callback({})
      }
      callback({ video: chosen })
    } catch (error) {
      console.warn('[mira-capture] getDisplayMedia getSources failed:', error)
      callback({})
    }
  }

  /** Show the desktop-source picker for `sources` and resolve to the chosen
   * source id, or '' when the user cancels or nothing is available. Parents the
   * modal to the focused Mira window (the recorder page that triggered the
   * request lives there). */
  private async chooseSource(sources: readonly DesktopCapturerSource[]): Promise<string> {
    if (!sources.length) return ''
    const picker = sources.map(toPickerSource)
    const parent = BrowserWindow.getFocusedWindow()
    this.pickerOpen = true
    try {
      const chosen = await showDesktopSourcePicker(picker, {
        parent,
        preloadPath: this.ensurePickerPreload()
      })
      return chosen ?? ''
    } finally {
      this.pickerOpen = false
    }
  }

  /** Write the picker-window preload once (same on-disk pattern as the capture
   * frame shim) and return its path. */
  private ensurePickerPreload(): string {
    if (this.pickerPreloadPath) return this.pickerPreloadPath
    const dir = join(this.userDataDir, 'sw-shims')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const path = join(dir, 'extension-capture-picker-preload.js')
    writeFileSync(path, PICKER_PRELOAD_SOURCE, 'utf8')
    this.pickerPreloadPath = path
    return path
  }

  /** Write the frame preload once and register it on the session. */
  private registerPreload(ses: Session): void {
    if (!this.shimPath) {
      const dir = join(this.userDataDir, 'sw-shims')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const path = join(dir, 'extension-capture-frame.js')
      writeFileSync(path, CAPTURE_SHIM_FRAME_SOURCE, 'utf8')
      this.shimPath = path
    }
    ses.registerPreloadScript({
      id: 'mira-extension-capture-frame',
      type: 'frame',
      filePath: this.shimPath
    })
  }
}

/** Adapt an Electron desktop source to the picker's self-contained view model:
 * thumbnail and app icon become PNG data URLs so the picker page needs no
 * file/crx fetch. */
function toPickerSource(source: DesktopCapturerSource): PickerSource {
  const appIcon = source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null
  return {
    id: source.id,
    name: source.name || 'Untitled',
    kind: pickerKind(source.id),
    thumbnail: source.thumbnail && !source.thumbnail.isEmpty() ? source.thumbnail.toDataURL() : '',
    appIcon
  }
}

/** One key per frame, matching between the arming ipc and the display-media
 * request that follows it. */
function frameKey(processId: number, routingId: number): string {
  return `${processId}:${routingId}`
}

/** The capture APIs, named as their manifest permissions. */
export type CaptureApi = 'tabCapture' | 'desktopCapture'

/** The extension id of a chrome-extension:// URL, or null for anything else.
 * Pure. */
export function extensionIdFromUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || !url.startsWith('chrome-extension://')) return null
  try {
    return new URL(url).host || null
  } catch {
    return null
  }
}

/** True when `manifest.permissions` lists `api`. Chrome gates
 * chrome.tabCapture / chrome.desktopCapture on these permissions. Known
 * limitation: an api listed only in optional_permissions and granted at runtime
 * through the lib's permissions.request is NOT honoured here (refused). Pure. */
export function extensionMayCapture(manifest: unknown, api: CaptureApi): boolean {
  if (!manifest || typeof manifest !== 'object') return false
  const permissions = (manifest as { permissions?: unknown }).permissions
  return Array.isArray(permissions) && permissions.includes(api)
}

/** The capture channels' authorization decision: the sender must be an
 * extension page, the extension must be loaded (its manifest found by
 * `getManifest`), and its manifest must declare `api`. Pure. */
export function authorizeCaptureSender(
  senderUrl: string | null | undefined,
  getManifest: (extensionId: string) => unknown,
  api: CaptureApi
): boolean {
  const id = extensionIdFromUrl(senderUrl)
  if (!id) return false
  return extensionMayCapture(getManifest(id), api)
}

/** Native glue: resolve the sender's extension in its own session. */
function senderMayCapture(event: IpcMainInvokeEvent, api: CaptureApi): boolean {
  const ses = event.sender.session
  return authorizeCaptureSender(
    event.senderFrame?.url,
    (id) => ses.extensions.getExtension(id)?.manifest ?? null,
    api
  )
}
