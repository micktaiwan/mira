// The CDP half of frame targeting (the pure half and the why: frame-target.ts).
// Thin on purpose: list a tab's frames, evaluate in one, measure where it sits
// in the top viewport, put files into an <input type=file>, and answer a native
// file chooser with files instead of letting macOS open its dialog.
//
// Every call goes through the tab's existing debugger (stealth.ts attaches it to
// every content view): never attach, never detach here, so nothing fights the
// stealth shim or the console wiring on the shared transport.
import type { WebContents } from 'electron'
import { evalInWebContents, interpretRuntimeEvaluate, type RuntimeEvaluateReply } from './cdp-eval'
import {
  FRAME_ORIGIN_FN,
  FrameTracker,
  addOffsets,
  fileChooserEvent,
  framePath,
  mergeFrameTrees,
  parentSession,
  pickFrame,
  type CdpFrameTree,
  type FrameInfo,
  type FrameSpec,
  type SessionTree
} from './frame-target'

const trackers = new WeakMap<WebContents, FrameTracker>()
const CALL_TIMEOUT_MS = 5_000

/** Start recording a tab's child sessions and frame contexts. Must run BEFORE
 * the console wiring's `Runtime.enable` / `Target.setAutoAttach`, whose replies
 * announce the contexts and targets that already exist. Idempotent. */
export function trackFrames(wc: WebContents): void {
  if (trackers.has(wc)) return
  const tracker = new FrameTracker()
  trackers.set(wc, tracker)
  wc.debugger.on('message', (_event, method, params, sessionId) =>
    tracker.feed(method, params, sessionId)
  )
}

function trackerOf(wc: WebContents): FrameTracker {
  const t = trackers.get(wc)
  if (!t)
    throw new Error('frames are not tracked on this tab (it predates the frame tracker: reload it)')
  return t
}

function send<T = unknown>(
  wc: WebContents,
  method: string,
  params: object,
  sessionId: string | null
): Promise<T> {
  if (!wc.debugger.isAttached()) return Promise.reject(new Error('no debugger on this tab'))
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`cdp ${method} timed out after ${CALL_TIMEOUT_MS}ms`)),
      CALL_TIMEOUT_MS
    )
    wc.debugger.sendCommand(method, params, sessionId ?? undefined).then(
      (v) => {
        clearTimeout(timer)
        resolve(v as T)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

/** Every frame of the tab, top document first (index 0), depth-first. */
export async function listFrames(wc: WebContents): Promise<FrameInfo[]> {
  const tracker = trackerOf(wc)
  const trees: SessionTree[] = []
  const main = await send<{ frameTree: CdpFrameTree }>(wc, 'Page.getFrameTree', {}, null)
  trees.push({ sessionId: null, tree: main.frameTree })
  for (const [sessionId, s] of tracker.sessions) {
    try {
      const r = await send<{ frameTree: CdpFrameTree }>(wc, 'Page.getFrameTree', {}, sessionId)
      trees.push({ sessionId, tree: r.frameTree, parentFrameId: s.parentFrameId })
    } catch {
      // A target that went away between the event and now: skip it.
    }
  }
  return mergeFrameTrees(trees)
}

/** Resolve a FrameSpec to a frame of the tab, or throw with the list. */
export async function resolveFrame(
  wc: WebContents,
  spec: FrameSpec
): Promise<{ frame: FrameInfo; frames: FrameInfo[] }> {
  const frames = await listFrames(wc)
  const frame = pickFrame(frames, spec)
  if ('error' in frame) throw new Error(frame.error)
  return { frame, frames }
}

/** The execution context to evaluate in for a frame: none for a target's root
 * (Runtime.evaluate defaults to its main world), the announced default context
 * otherwise, and as a last resort an isolated world (same DOM, but the page's
 * own JS globals are not visible from there). */
async function contextParams(wc: WebContents, frame: FrameInfo): Promise<{ contextId?: number }> {
  if (frame.ownTarget || frame.parentId === null) return {}
  const id = trackerOf(wc).contextFor(frame.sessionId, frame.frameId)
  if (id !== undefined) return { contextId: id }
  const world = await send<{ executionContextId: number }>(
    wc,
    'Page.createIsolatedWorld',
    { frameId: frame.frameId, worldName: 'mira-frame' },
    frame.sessionId
  )
  return { contextId: world.executionContextId }
}

/** Evaluate `code` in a frame and return its JSON value (exec-js semantics). */
export async function evalInFrame(
  wc: WebContents,
  frame: FrameInfo,
  code: string
): Promise<unknown> {
  if (frame.parentId === null) return evalInWebContents(wc, code)
  const ctx = await contextParams(wc, frame)
  const reply = await send<RuntimeEvaluateReply>(
    wc,
    'Runtime.evaluate',
    { expression: code, returnByValue: true, awaitPromise: true, userGesture: true, ...ctx },
    frame.sessionId
  )
  return interpretRuntimeEvaluate(reply)
}

/** Evaluate `code` in a frame and keep the result as a remote object (for
 * DOM.setFileInputFiles). Throws the page's own error when the code throws. */
async function remoteInFrame(
  wc: WebContents,
  frame: FrameInfo | null,
  code: string
): Promise<string> {
  const ctx = frame ? await contextParams(wc, frame) : {}
  const session = frame ? frame.sessionId : null
  const reply = await send<RuntimeEvaluateReply & { result?: { objectId?: string } }>(
    wc,
    'Runtime.evaluate',
    { expression: code, returnByValue: false, ...ctx },
    session
  )
  if (reply.exceptionDetails) interpretRuntimeEvaluate(reply) // throws the page's message
  const id = reply.result?.objectId
  if (!id) throw new Error('the page returned no element')
  return id
}

/** Where a frame's viewport starts in the TOP viewport: the sum of every
 * holder <iframe>'s content-box origin, each measured in its own parent. */
export async function frameOffset(
  wc: WebContents,
  frames: FrameInfo[],
  frame: FrameInfo
): Promise<{ x: number; y: number }> {
  const origins: Array<{ x: number; y: number }> = []
  for (const f of framePath(frames, frame.frameId)) {
    const session = parentSession(frames, f)
    const owner = await send<{ backendNodeId: number }>(
      wc,
      'DOM.getFrameOwner',
      { frameId: f.frameId },
      session
    )
    const node = await send<{ object: { objectId?: string } }>(
      wc,
      'DOM.resolveNode',
      { backendNodeId: owner.backendNodeId },
      session
    )
    const objectId = node.object.objectId
    if (!objectId) throw new Error(`cannot measure the <iframe> holding frame #${f.index}`)
    try {
      const r = await send<RuntimeEvaluateReply>(
        wc,
        'Runtime.callFunctionOn',
        { objectId, functionDeclaration: FRAME_ORIGIN_FN, returnByValue: true },
        session
      )
      origins.push(interpretRuntimeEvaluate(r) as { x: number; y: number })
    } finally {
      send(wc, 'Runtime.releaseObject', { objectId }, session).catch(() => {})
    }
  }
  return addOffsets({ x: 0, y: 0 }, origins)
}

/** Put local files into an <input type=file> of a frame, through CDP: the
 * browser itself sets the files and fires input/change (trusted), as if the
 * user had picked them. Paths are read by Chromium, nothing crosses the socket. */
export async function setFilesOnInput(
  wc: WebContents,
  frame: FrameInfo | null,
  expression: string,
  files: string[]
): Promise<void> {
  const objectId = await remoteInFrame(wc, frame, expression)
  const session = frame ? frame.sessionId : null
  try {
    await send(wc, 'DOM.setFileInputFiles', { files, objectId }, session)
  } finally {
    send(wc, 'Runtime.releaseObject', { objectId }, session).catch(() => {})
  }
}

/** Run `action` (a click) with file-chooser interception on in every target of
 * the tab, wait for the chooser it opens, and answer it with `files`. No macOS
 * dialog appears. Interception is switched off again whatever happens. */
export async function answerFileChooser(
  wc: WebContents,
  files: string[],
  action: () => Promise<void>,
  timeoutMs: number
): Promise<{ frameId: string; mode: string }> {
  const sessions: Array<string | null> = [null, ...trackerOf(wc).sessions.keys()]
  let onMessage: ((e: unknown, m: string, p: unknown, s?: string) => void) | null = null
  const opened = new Promise<{
    backendNodeId: number
    mode: string
    frameId: string
    session: string | null
  }>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `no file chooser opened within ${timeoutMs}ms after the click (the click may have opened something else: snap the frame)`
          )
        ),
      timeoutMs
    )
    onMessage = (_e, method, params, sessionId) => {
      const ev = fileChooserEvent(method, params)
      if (!ev) return
      clearTimeout(timer)
      resolve({ ...ev, session: sessionId ? sessionId : null })
    }
    wc.debugger.on('message', onMessage)
  })
  opened.catch(() => {}) // observed below; never an unhandled rejection
  try {
    for (const s of sessions) {
      await send(wc, 'Page.enable', {}, s).catch(() => {})
      await send(wc, 'Page.setInterceptFileChooserDialog', { enabled: true }, s).catch(() => {})
    }
    await action()
    const ev = await opened
    if (ev.mode === 'selectSingle' && files.length > 1) {
      throw new Error(`the chooser takes one file, ${files.length} given`)
    }
    await send(wc, 'DOM.setFileInputFiles', { files, backendNodeId: ev.backendNodeId }, ev.session)
    return { frameId: ev.frameId, mode: ev.mode }
  } finally {
    if (onMessage) wc.debugger.removeListener('message', onMessage)
    for (const s of sessions) {
      await send(wc, 'Page.setInterceptFileChooserDialog', { enabled: false }, s).catch(() => {})
    }
  }
}

/** One page target to drive: the top document (no spec) or a named frame.
 * `evaluate` runs code there; `toTop` turns a point measured there into the
 * top-viewport point CDP input expects; `label` says which frame for a reply. */
export interface FrameScope {
  evaluate: (code: string) => Promise<unknown>
  toTop: (p: { x: number; y: number }) => Promise<{ x: number; y: number }>
  frame: FrameInfo | null
  label: string
}

export async function frameScope(wc: WebContents, spec?: FrameSpec): Promise<FrameScope> {
  if (!spec) {
    return {
      evaluate: (code) => evalInWebContents(wc, code),
      toTop: async (p) => p,
      frame: null,
      label: ''
    }
  }
  const { frame, frames } = await resolveFrame(wc, spec)
  let offset: { x: number; y: number } | null = null
  return {
    evaluate: (code) => evalInFrame(wc, frame, code),
    toTop: async (p) => {
      // Measured once per scope: the holders do not move between resolving a
      // target and clicking it, and each measure is a few CDP round trips.
      offset ??= await frameOffset(wc, frames, frame)
      return addOffsets(p, [offset])
    },
    frame,
    label: frame.parentId === null ? '' : ` in frame #${frame.index}`
  }
}
