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
      // Not an armed extension capture: deny, as the handler-less session did.
      callback({})
    })
  }

  /** The two page->main channels, once per app (ipcMain is global). Senders
   * are validated to extension pages — a web page invoking these channels gets
   * an error, not a capture. */
  private installIpc(): void {
    if (this.ipcInstalled) return
    this.ipcInstalled = true
    ipcMain.handle(
      CHOOSE_DESKTOP_MEDIA_IPC_CHANNEL,
      async (event, payload: { sources?: unknown }) => {
        if (!isExtensionSender(event)) return { streamId: '' }
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
      if (!isExtensionSender(event)) return { ok: false, error: 'not an extension page' }
      const frame = event.senderFrame
      if (!frame) return { ok: false, error: 'no sender frame' }
      armFrame(this.pendingTabCapture, frameKey(frame.processId, frame.routingId), Date.now())
      return { ok: true }
    })
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

/** Only extension pages may drive the capture channels. */
function isExtensionSender(event: IpcMainInvokeEvent): boolean {
  return event.senderFrame?.url?.startsWith('chrome-extension://') ?? false
}
