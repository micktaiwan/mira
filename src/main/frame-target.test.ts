import { describe, expect, it } from 'vitest'
import {
  FrameTracker,
  addOffsets,
  fileChooserEvent,
  fileInputExpression,
  framePath,
  mergeFrameTrees,
  parentSession,
  parseFrameParam,
  pickFrame,
  type SessionTree
} from './frame-target'

describe('parseFrameParam', () => {
  it('absent means the top document', () => {
    expect(parseFrameParam(undefined)).toBeUndefined()
    expect(parseFrameParam(null)).toBeUndefined()
  })
  it('a number or a digit string is an index', () => {
    expect(parseFrameParam(2)).toEqual({ kind: 'index', index: 2 })
    expect(parseFrameParam('0')).toEqual({ kind: 'index', index: 0 })
  })
  it('any other string is a url substring', () => {
    expect(parseFrameParam(' userCodeAppPanel ')).toEqual({
      kind: 'match',
      value: 'userCodeAppPanel'
    })
  })
  it('refuses junk', () => {
    expect(parseFrameParam(-1)).toHaveProperty('error')
    expect(parseFrameParam(1.5)).toHaveProperty('error')
    expect(parseFrameParam('')).toHaveProperty('error')
    expect(parseFrameParam({})).toHaveProperty('error')
  })
})

// An Apps Script shape: top page → cross-origin sandbox (own target) → a
// same-origin inner frame living in the sandbox's target.
const appsScript: SessionTree[] = [
  {
    sessionId: null,
    tree: {
      frame: { id: 'TOP', url: 'https://script.google.com/exec' },
      childFrames: [
        { frame: { id: 'SANDBOX', parentId: 'TOP', url: 'about:blank', name: 'sandboxFrame' } }
      ]
    }
  },
  {
    sessionId: 'S1',
    tree: {
      frame: {
        id: 'SANDBOX',
        url: 'https://n-1-script.googleusercontent.com/userCodeAppPanel',
        name: 'sandboxFrame'
      },
      childFrames: [
        {
          frame: {
            id: 'INNER',
            parentId: 'SANDBOX',
            url: 'https://n-1-script.googleusercontent.com/blank',
            name: 'userHtmlFrame'
          }
        }
      ]
    }
  }
]

describe('mergeFrameTrees', () => {
  it('lists every frame depth-first, owned by the session that roots it', () => {
    const frames = mergeFrameTrees(appsScript)
    expect(frames.map((f) => [f.index, f.frameId, f.depth, f.sessionId, f.ownTarget])).toEqual([
      [0, 'TOP', 0, null, false],
      [1, 'SANDBOX', 1, 'S1', true],
      [2, 'INNER', 2, 'S1', false]
    ])
    // The owning target's url wins over the parent's placeholder.
    expect(frames[1].url).toContain('userCodeAppPanel')
  })

  it('places a child target the parent tree does not list, under its holder', () => {
    const trees: SessionTree[] = [
      { sessionId: null, tree: { frame: { id: 'TOP', url: 'http://localhost:8001/' } } },
      {
        sessionId: 'S2',
        parentFrameId: 'S1F',
        tree: { frame: { id: 'S2F', url: 'http://127.0.0.2:8003/deep' } }
      },
      {
        sessionId: 'S1',
        parentFrameId: 'TOP',
        tree: { frame: { id: 'S1F', url: 'http://127.0.0.1:8002/mid' } }
      }
    ]
    const frames = mergeFrameTrees(trees)
    expect(frames.map((f) => [f.frameId, f.parentId, f.depth])).toEqual([
      ['TOP', null, 0],
      ['S1F', 'TOP', 1],
      ['S2F', 'S1F', 2]
    ])
  })

  it('hangs an orphan child target off the top frame rather than losing it', () => {
    const frames = mergeFrameTrees([
      { sessionId: null, tree: { frame: { id: 'TOP', url: 'a' } } },
      { sessionId: 'S9', tree: { frame: { id: 'X', url: 'b' } } }
    ])
    expect(frames.map((f) => [f.frameId, f.parentId])).toEqual([
      ['TOP', null],
      ['X', 'TOP']
    ])
  })

  it('no main tree, no frames', () => {
    expect(mergeFrameTrees([])).toEqual([])
  })
})

describe('pickFrame', () => {
  const frames = mergeFrameTrees(appsScript)
  it('by index', () => {
    expect(pickFrame(frames, { kind: 'index', index: 2 })).toMatchObject({ frameId: 'INNER' })
    expect(pickFrame(frames, { kind: 'index', index: 7 })).toMatchObject({
      error: expect.stringContaining('no frame #7')
    })
  })
  it('by url substring or exact name', () => {
    expect(pickFrame(frames, { kind: 'match', value: 'userCodeAppPanel' })).toMatchObject({
      frameId: 'SANDBOX'
    })
    expect(pickFrame(frames, { kind: 'match', value: 'userHtmlFrame' })).toMatchObject({
      frameId: 'INNER'
    })
  })
  it('refuses an ambiguous match with the candidates, and a miss with the list', () => {
    const amb = pickFrame(frames, { kind: 'match', value: 'googleusercontent' })
    expect(amb).toMatchObject({ error: expect.stringContaining('2 frames match') })
    expect((amb as { error: string }).error).toContain('#1')
    expect(pickFrame(frames, { kind: 'match', value: 'nope' })).toMatchObject({
      error: expect.stringContaining('#0 https://script.google.com/exec')
    })
  })
})

describe('framePath / parentSession / addOffsets', () => {
  const frames = mergeFrameTrees(appsScript)
  it('walks from below the top down to the frame', () => {
    expect(framePath(frames, 'INNER').map((f) => f.frameId)).toEqual(['SANDBOX', 'INNER'])
    expect(framePath(frames, 'TOP')).toEqual([])
  })
  it('asks the frame owner in the parent session', () => {
    expect(parentSession(frames, frames[1])).toBeNull()
    expect(parentSession(frames, frames[2])).toBe('S1')
  })
  it('sums the holders origins onto the point', () => {
    expect(
      addOffsets({ x: 5, y: 6 }, [
        { x: 10, y: 100 },
        { x: 1, y: 2 }
      ])
    ).toEqual({ x: 16, y: 108 })
  })
})

describe('FrameTracker', () => {
  it('records iframe targets and default contexts per session', () => {
    const t = new FrameTracker()
    t.feed('Target.attachedToTarget', {
      sessionId: 'S1',
      targetInfo: { type: 'iframe', targetId: 'SANDBOX', url: 'u', parentFrameId: 'TOP' }
    })
    t.feed('Target.attachedToTarget', {
      sessionId: 'W',
      targetInfo: { type: 'worker', targetId: 'w' }
    })
    t.feed(
      'Runtime.executionContextCreated',
      { context: { id: 7, auxData: { isDefault: true, frameId: 'INNER' } } },
      'S1'
    )
    t.feed(
      'Runtime.executionContextCreated',
      { context: { id: 8, auxData: { isDefault: false, frameId: 'INNER' } } },
      'S1'
    )
    t.feed(
      'Runtime.executionContextCreated',
      { context: { id: 3, auxData: { isDefault: true, frameId: 'SAME' } } },
      ''
    )
    expect([...t.sessions.keys()]).toEqual(['S1'])
    expect(t.sessions.get('S1')).toMatchObject({
      targetId: 'SANDBOX',
      parentSession: null,
      parentFrameId: 'TOP'
    })
    expect(t.contextFor('S1', 'INNER')).toBe(7)
    expect(t.contextFor(null, 'SAME')).toBe(3)
    t.feed('Runtime.executionContextDestroyed', { executionContextId: 7 }, 'S1')
    expect(t.contextFor('S1', 'INNER')).toBeUndefined()
  })

  it('drops a detached session, its contexts and its nested children', () => {
    const t = new FrameTracker()
    t.feed('Target.attachedToTarget', {
      sessionId: 'S1',
      targetInfo: { type: 'iframe', targetId: 'A' }
    })
    t.feed(
      'Target.attachedToTarget',
      { sessionId: 'S2', targetInfo: { type: 'iframe', targetId: 'B' } },
      'S1'
    )
    t.feed(
      'Runtime.executionContextCreated',
      { context: { id: 1, auxData: { isDefault: true, frameId: 'A' } } },
      'S1'
    )
    t.feed('Target.detachedFromTarget', { sessionId: 'S1' })
    expect(t.sessions.size).toBe(0)
    expect(t.contextFor('S1', 'A')).toBeUndefined()
  })

  it('clears a session contexts on executionContextsCleared (navigation)', () => {
    const t = new FrameTracker()
    t.feed('Runtime.executionContextCreated', {
      context: { id: 1, auxData: { isDefault: true, frameId: 'F' } }
    })
    t.feed('Runtime.executionContextsCleared', {})
    expect(t.contextFor(null, 'F')).toBeUndefined()
  })
})

describe('fileChooserEvent', () => {
  it('reads Page.fileChooserOpened only', () => {
    expect(
      fileChooserEvent('Page.fileChooserOpened', {
        backendNodeId: 12,
        mode: 'selectMultiple',
        frameId: 'F'
      })
    ).toEqual({
      backendNodeId: 12,
      mode: 'selectMultiple',
      frameId: 'F'
    })
    expect(fileChooserEvent('Page.fileChooserOpened', { mode: 'x' })).toBeNull()
    expect(fileChooserEvent('Page.frameNavigated', {})).toBeNull()
  })
})

describe('fileInputExpression', () => {
  it('returns the nth match and refuses a non-file element', () => {
    const code = fileInputExpression('input.receipt', 2)
    expect(code).toContain('document.querySelectorAll("input.receipt")')
    expect(code).toContain('all[1]')
    expect(code).toContain("el.type !== 'file'")
  })
})
