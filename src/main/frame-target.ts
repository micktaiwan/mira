// Reaching into a tab's iframes, cross-origin ones included.
//
// Why this exists: exec-js, snapshot, click --text and upload all ran in the TOP
// document only. A page whose whole UI lives in a cross-origin iframe (a Google
// Apps Script web app renders everything inside `iframe#sandboxFrame`, served
// from *.googleusercontent.com) was unreachable: `document.body.innerText` gave
// the page title, `click --text` found nothing visible, and a screenshot was the
// only way to read it.
//
// How a frame is reached, over the CDP debugger Mira already attaches to every
// tab (stealth.ts):
//   - a cross-origin (out-of-process) iframe is its own CDP target. The tab's
//     console wiring (wirePageConsole in profiles.ts) already auto-attaches every
//     child target with `flatten: true`, so each one has a sessionId on the same
//     transport, and nested ones are re-armed from their parent;
//   - a same-process iframe lives in its parent's target and is reached through
//     its default execution context (`Runtime.executionContextCreated`, which the
//     console wiring's `Runtime.enable` makes the target announce).
// The FrameTracker below records both from the debugger's message stream; the
// frame list itself is rebuilt on demand from `Page.getFrameTree` of every
// session, merged here.
//
// Pure (no Electron): the CDP calls live in frame-cdp.ts.

/** What a caller names: an index from `list-frames` (0 = the top document) or a
 * piece of the frame's url (or its exact `name`). */
export type FrameSpec = { kind: 'index'; index: number } | { kind: 'match'; value: string }

/** Validate the `frame` param of a page command. `undefined` = top document,
 * the behaviour every command had before frames existed. */
export function parseFrameParam(v: unknown): FrameSpec | undefined | { error: string } {
  if (v === undefined || v === null) return undefined
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v < 0) return { error: '"frame" index must be an integer ≥ 0' }
    return { kind: 'index', index: v }
  }
  if (typeof v === 'string') {
    const s = v.trim()
    if (s === '') return { error: '"frame" must be an index or a non-empty url substring' }
    if (/^\d+$/.test(s)) return { kind: 'index', index: Number(s) }
    return { kind: 'match', value: s }
  }
  return { error: '"frame" must be an index (number) or a url substring (string)' }
}

/** The slice of a CDP `Page.Frame` we read. */
export interface CdpFrame {
  id: string
  parentId?: string
  url: string
  urlFragment?: string
  name?: string
  securityOrigin?: string
}

/** A CDP `Page.FrameTree`. */
export interface CdpFrameTree {
  frame: CdpFrame
  childFrames?: CdpFrameTree[]
}

/** One session's `Page.getFrameTree`: the tab's own target (sessionId null) or
 * an out-of-process iframe's target, whose root frame IS that iframe. */
export interface SessionTree {
  sessionId: string | null
  tree: CdpFrameTree
  /** For a child target: the frame that holds it, when the target said so. */
  parentFrameId?: string
}

/** One frame of a tab, as `list-frames` reports it. */
export interface FrameInfo {
  /** Position in the depth-first order; 0 is the top document. */
  index: number
  frameId: string
  parentId: string | null
  url: string
  name: string
  depth: number
  /** CDP session that hosts the frame's document (null = the tab's own target). */
  sessionId: string | null
  /** True when the frame is the root of its own target (out-of-process). */
  ownTarget: boolean
}

interface Node {
  frame: CdpFrame
  sessionId: string | null
  ownTarget: boolean
  parentId: string | null
  children: string[]
}

/** Merge every session's frame tree into one depth-first list.
 *
 * A child target's root frame may also appear in the parent's tree (as a
 * placeholder for the remote frame) or not at all: both are handled. The frame
 * belongs to the session whose tree it ROOTS; its children come from that
 * session. A child target whose holder is unknown hangs off the top frame, so it
 * is listed rather than lost. */
export function mergeFrameTrees(trees: SessionTree[]): FrameInfo[] {
  const main = trees.find((t) => t.sessionId === null)
  if (!main) return []
  const owners = new Map<string, SessionTree>()
  for (const t of trees) if (t.sessionId !== null) owners.set(t.tree.frame.id, t)
  const nodes = new Map<string, Node>()

  const link = (parentId: string | null, id: string): void => {
    if (parentId === null) return
    const p = nodes.get(parentId)
    if (p && !p.children.includes(id)) p.children.push(id)
  }
  const walk = (tree: CdpFrameTree, sessionId: string | null, parentId: string | null): void => {
    const id = tree.frame.id
    const own = owners.get(id)
    const session = own ? own.sessionId : sessionId
    const existing = nodes.get(id)
    if (!existing) {
      nodes.set(id, {
        frame: tree.frame,
        sessionId: session,
        ownTarget: own !== undefined,
        parentId,
        children: []
      })
      link(parentId, id)
    } else if (own && tree === own.tree) {
      // The owning session's view of the frame is the authoritative one (its url
      // is the document actually loaded, not the placeholder's).
      existing.frame = { ...existing.frame, ...tree.frame }
      existing.sessionId = own.sessionId
    }
    for (const c of tree.childFrames ?? []) walk(c, nodes.get(id)?.sessionId ?? session, id)
  }

  walk(main.tree, null, null)
  const rootId = main.tree.frame.id
  // Child targets, attached under their holder. Repeat until nothing moves so a
  // nested out-of-process frame finds its out-of-process parent.
  let pending = trees.filter((t) => t.sessionId !== null)
  for (let moved = true; moved && pending.length > 0;) {
    moved = false
    pending = pending.filter((t) => {
      const id = t.tree.frame.id
      const parent = nodes.has(id)
        ? nodes.get(id)!.parentId
        : (t.parentFrameId ?? t.tree.frame.parentId ?? null)
      if (!nodes.has(id) && (parent === null || !nodes.has(parent))) return true
      walk(t.tree, t.sessionId, nodes.has(id) ? nodes.get(id)!.parentId : parent)
      moved = true
      return false
    })
  }
  for (const t of pending) walk(t.tree, t.sessionId, rootId)

  const out: FrameInfo[] = []
  const visit = (id: string, depth: number): void => {
    const n = nodes.get(id)
    if (!n) return
    out.push({
      index: out.length,
      frameId: id,
      parentId: n.parentId,
      url: (n.frame.url ?? '') + (n.frame.urlFragment ?? ''),
      name: n.frame.name ?? '',
      depth,
      sessionId: n.sessionId,
      ownTarget: n.ownTarget
    })
    for (const c of n.children) visit(c, depth + 1)
  }
  visit(rootId, 0)
  return out
}

/** A frame as one line of an error message. */
function describe(f: FrameInfo): string {
  return `#${f.index} ${f.url || '(no url)'}${f.name ? ` name=${f.name}` : ''}`
}

/** Pick the frame a caller named. A url substring that matches several frames
 * is refused with the list, rather than picking one the caller cannot see. */
export function pickFrame(frames: FrameInfo[], spec: FrameSpec): FrameInfo | { error: string } {
  const list = (): string => frames.map(describe).join('; ')
  if (spec.kind === 'index') {
    const f = frames[spec.index]
    if (!f) return { error: `no frame #${spec.index} (${frames.length} frame(s): ${list()})` }
    return f
  }
  // An exact name wins; otherwise a substring of the url or of the name (a frame
  // named `legacy-iframe-2185` is reached by `legacy-iframe`).
  const exact = frames.filter((f) => f.name === spec.value)
  const hits = exact.length
    ? exact
    : frames.filter((f) => f.url.includes(spec.value) || f.name.includes(spec.value))
  if (hits.length === 1) return hits[0]
  if (hits.length === 0) return { error: `no frame matches "${spec.value}" (frames: ${list()})` }
  return {
    error: `${hits.length} frames match "${spec.value}", pass an index: ${hits.map(describe).join('; ')}`
  }
}

/** The frames from just below the top down to `frameId`, in order. Each one
 * contributes its holder's content-box origin to the frame's offset in the
 * top viewport. Empty for the top frame. */
export function framePath(frames: FrameInfo[], frameId: string): FrameInfo[] {
  const byId = new Map(frames.map((f) => [f.frameId, f]))
  const path: FrameInfo[] = []
  for (let f = byId.get(frameId); f && f.parentId !== null; f = byId.get(f.parentId)) {
    path.unshift(f)
    if (path.length > frames.length) break // a cycle would be a CDP bug; never loop
  }
  return path
}

/** Session of a frame's parent: where `DOM.getFrameOwner` must be asked. */
export function parentSession(frames: FrameInfo[], f: FrameInfo): string | null {
  const p = frames.find((x) => x.frameId === f.parentId)
  return p ? p.sessionId : null
}

/** Sum of the holders' origins: add it to a point measured inside the frame to
 * get the top-viewport point CDP input expects. */
export function addOffsets(
  point: { x: number; y: number },
  origins: Array<{ x: number; y: number }>
): { x: number; y: number } {
  return origins.reduce((p, o) => ({ x: p.x + o.x, y: p.y + o.y }), point)
}

/** Function run (Runtime.callFunctionOn) on an <iframe> element in its parent's
 * document: where the frame's viewport starts, in the parent's viewport. The
 * content box, not the border box: border and padding push the child's (0,0). */
export const FRAME_ORIGIN_FN = `function () {
  const r = this.getBoundingClientRect()
  const s = getComputedStyle(this)
  return {
    x: r.left + this.clientLeft + (parseFloat(s.paddingLeft) || 0),
    y: r.top + this.clientTop + (parseFloat(s.paddingTop) || 0)
  }
}`

/** Live map of a tab's CDP child sessions and per-frame default contexts, fed
 * the debugger's message stream. Pure: give it (method, params, sessionId). */
export class FrameTracker {
  /** Child sessions: sessionId → { targetId, parent session, parentFrameId }. */
  readonly sessions = new Map<
    string,
    { targetId: string; url: string; parentSession: string | null; parentFrameId?: string }
  >()
  /** `${session}|${frameId}` → default (main-world) execution context id. */
  private readonly contexts = new Map<string, number>()

  private static key(session: string | null, frameId: string): string {
    return `${session ?? ''}|${frameId}`
  }

  feed(method: string, params: unknown, sessionId?: string | null): void {
    const session = sessionId ? sessionId : null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CDP payloads, read defensively below
    const p = (params ?? {}) as Record<string, any>
    switch (method) {
      case 'Target.attachedToTarget': {
        const info = p.targetInfo ?? {}
        if (info.type !== 'iframe' || typeof p.sessionId !== 'string') return
        this.sessions.set(p.sessionId, {
          targetId: String(info.targetId ?? ''),
          url: String(info.url ?? ''),
          parentSession: session,
          parentFrameId: typeof info.parentFrameId === 'string' ? info.parentFrameId : undefined
        })
        return
      }
      case 'Target.detachedFromTarget': {
        if (typeof p.sessionId !== 'string') return
        this.dropSession(p.sessionId)
        return
      }
      case 'Runtime.executionContextCreated': {
        const c = p.context ?? {}
        const aux = c.auxData ?? {}
        if (aux.isDefault !== true || typeof aux.frameId !== 'string') return
        if (typeof c.id !== 'number') return
        this.contexts.set(FrameTracker.key(session, aux.frameId), c.id)
        return
      }
      case 'Runtime.executionContextDestroyed': {
        const id = p.executionContextId
        const prefix = `${session ?? ''}|`
        for (const [k, v] of this.contexts)
          if (k.startsWith(prefix) && v === id) this.contexts.delete(k)
        return
      }
      case 'Runtime.executionContextsCleared': {
        const prefix = `${session ?? ''}|`
        for (const k of [...this.contexts.keys()]) if (k.startsWith(prefix)) this.contexts.delete(k)
        return
      }
    }
  }

  private dropSession(sessionId: string): void {
    this.sessions.delete(sessionId)
    for (const k of [...this.contexts.keys()])
      if (k.startsWith(`${sessionId}|`)) this.contexts.delete(k)
    // A detached parent takes its nested children with it.
    for (const [id, s] of [...this.sessions])
      if (s.parentSession === sessionId) this.dropSession(id)
  }

  /** Default context of a frame in a session, if one was announced. */
  contextFor(session: string | null, frameId: string): number | undefined {
    return this.contexts.get(FrameTracker.key(session, frameId))
  }
}

/** The `Page.fileChooserOpened` the upload waits for, or null for any other
 * message. */
export function fileChooserEvent(
  method: string,
  params: unknown
): { backendNodeId: number; mode: string; frameId: string } | null {
  if (method !== 'Page.fileChooserOpened') return null
  const p = (params ?? {}) as Record<string, unknown>
  if (typeof p.backendNodeId !== 'number') return null
  return {
    backendNodeId: p.backendNodeId,
    mode: typeof p.mode === 'string' ? p.mode : 'selectSingle',
    frameId: typeof p.frameId === 'string' ? p.frameId : ''
  }
}

/** The page-side expression that returns the nth element matching `selector`,
 * or throws naming what it found. Evaluated WITHOUT returnByValue so CDP hands
 * back a remote object, which DOM.setFileInputFiles takes as is. */
export function fileInputExpression(selector: string, nth: number): string {
  const s = JSON.stringify(selector)
  return `(() => {
  const all = document.querySelectorAll(${s})
  const el = all[${nth - 1}]
  if (!el) throw new Error('no element matches ' + ${s} + ' (found ' + all.length + ')')
  if (!(el instanceof HTMLInputElement) || el.type !== 'file') {
    throw new Error(${s} + ' matches a <' + el.tagName.toLowerCase() + '>, not an <input type=file>')
  }
  return el
})()`
}
