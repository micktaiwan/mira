import { describe, it, expect } from 'vitest'
import {
  STORAGE_AREAS,
  STORAGE_FRAME_MAIN_WORLD,
  STORAGE_FRAME_PRELOAD_SOURCE,
  STORAGE_WORKER_MAIN_WORLD,
  STORAGE_WORKER_PRELOAD_SOURCE,
  isStorageArea,
  readListening,
  readStorageReport
} from './extension-storage-events'

describe('isStorageArea', () => {
  it('accepts the two areas the bridge covers', () => {
    expect(isStorageArea('local')).toBe(true)
    expect(isStorageArea('session')).toBe(true)
  })

  it('rejects the aliased areas and anything else', () => {
    // sync/managed ARE chrome.storage.local in this stack, so a write through
    // them is reported as a local one — never under their own name.
    expect(isStorageArea('sync')).toBe(false)
    expect(isStorageArea('managed')).toBe(false)
    expect(isStorageArea('')).toBe(false)
    expect(isStorageArea(undefined)).toBe(false)
    expect(isStorageArea(1)).toBe(false)
  })
})

describe('readStorageReport', () => {
  it('reads a well-formed report', () => {
    expect(readStorageReport({ area: 'session', saved: ['a'], removed: ['b'] })).toEqual({
      area: 'session',
      saved: ['a'],
      removed: ['b']
    })
  })

  it('drops non-string and empty keys, and collapses duplicates', () => {
    expect(
      readStorageReport({ area: 'local', saved: ['a', 'a', '', 7, null, 'b'], removed: [] })
    ).toEqual({ area: 'local', saved: ['a', 'b'], removed: [] })
  })

  it('counts a key that is both saved and removed as saved', () => {
    // The write is what happened last; reporting it as removed would tell a
    // state framework to forget a value that is actually there.
    expect(readStorageReport({ area: 'local', saved: ['k'], removed: ['k', 'j'] })).toEqual({
      area: 'local',
      saved: ['k'],
      removed: ['j']
    })
  })

  it('drops anything malformed rather than repairing it', () => {
    expect(readStorageReport(null)).toBeNull()
    expect(readStorageReport('nope')).toBeNull()
    expect(readStorageReport({ saved: ['a'], removed: [] })).toBeNull()
    expect(readStorageReport({ area: 'sync', saved: ['a'], removed: [] })).toBeNull()
    expect(readStorageReport({ area: 'local', saved: 'a', removed: [] })).toBeNull()
  })

  it('is null when nothing was touched, so no empty delivery is sent', () => {
    expect(readStorageReport({ area: 'local', saved: [], removed: [] })).toBeNull()
  })
})

describe('readListening', () => {
  it('reads the flag both ways', () => {
    expect(readListening({ listening: true })).toBe(true)
    expect(readListening({ listening: false })).toBe(false)
  })

  it('is null for anything that does not say', () => {
    expect(readListening(null)).toBeNull()
    expect(readListening({})).toBeNull()
    expect(readListening({ listening: 'yes' })).toBeNull()
  })
})

describe('injected halves', () => {
  it('the worker half installs an onChanged for every covered area', () => {
    for (const area of STORAGE_AREAS) {
      expect(STORAGE_WORKER_MAIN_WORLD).toContain(JSON.stringify(area).slice(1, -1))
    }
    // Assignment is not enough: an area's onChanged is a getter-only accessor.
    expect(STORAGE_WORKER_MAIN_WORLD).not.toContain('.onChanged =')
    expect(STORAGE_WORKER_MAIN_WORLD).toContain("Object.defineProperty(target, 'onChanged'")
  })

  it('the frame half reports writes but installs no event', () => {
    // Renderers already get Electron's native events; dispatching there too
    // would double-fire every listener in the popup.
    expect(STORAGE_FRAME_MAIN_WORLD).toContain('bridge.report')
    expect(STORAGE_FRAME_MAIN_WORLD).not.toContain('onChanged')
  })

  it('both halves wrap the three writers', () => {
    for (const source of [STORAGE_WORKER_MAIN_WORLD, STORAGE_FRAME_MAIN_WORLD]) {
      expect(source).toContain('area.set = function')
      expect(source).toContain('area.remove = function')
      expect(source).toContain('area.clear = function')
    }
  })

  it('the frame preload leaves immediately outside an extension page', () => {
    expect(STORAGE_FRAME_PRELOAD_SOURCE).toContain(
      "if (href.indexOf('chrome-extension://') !== 0) return;"
    )
  })

  it('the worker preload only runs in a service worker', () => {
    expect(STORAGE_WORKER_PRELOAD_SOURCE).toContain("process.type !== 'service-worker'")
  })

  it('neither preload sends an extension id — main reads it from the sender', () => {
    for (const source of [STORAGE_WORKER_PRELOAD_SOURCE, STORAGE_FRAME_PRELOAD_SOURCE]) {
      expect(source).not.toContain('extensionId')
    }
  })
})

// --- the injected halves, actually run ---------------------------------------
//
// The two main-world sources are the code that ships; running them against a
// fake `chrome` is the only way to test them without an Electron worker. Each
// source is compiled with `globalThis` as a PARAMETER, which shadows the real
// one — the install guard it plants (`__miraStorageEvents`, non-configurable)
// would otherwise let only the first test install anything.

interface FakeArea {
  get: (keys?: unknown) => Promise<Record<string, unknown>>
  set: (items: Record<string, unknown>, cb?: () => void) => unknown
  remove: (keys: unknown, cb?: () => void) => unknown
  clear: (cb?: () => void) => unknown
  onChanged: { addListener: (fn: unknown) => void; native: true }
  data: Record<string, unknown>
  calls: string[]
}

function fakeArea(initial: Record<string, unknown> = {}): FakeArea {
  const data: Record<string, unknown> = { ...initial }
  const calls: string[] = []
  const nativeEvent = { addListener: (): void => {}, native: true as const }
  const list = (keys: unknown): string[] =>
    Array.isArray(keys) ? (keys as string[]) : typeof keys === 'string' ? [keys] : Object.keys(data)
  return {
    data,
    calls,
    get: (keys?: unknown) => {
      calls.push('get')
      const out: Record<string, unknown> = {}
      for (const key of keys == null ? Object.keys(data) : list(keys)) {
        if (Object.prototype.hasOwnProperty.call(data, key)) out[key] = data[key]
      }
      return Promise.resolve(out)
    },
    set: (items: Record<string, unknown>) => {
      calls.push('set')
      Object.assign(data, items)
      return Promise.resolve()
    },
    remove: (keys: unknown) => {
      calls.push('remove')
      for (const key of list(keys)) delete data[key]
      return Promise.resolve()
    },
    clear: () => {
      calls.push('clear')
      for (const key of Object.keys(data)) delete data[key]
      return Promise.resolve()
    },
    // An AREA's onChanged is an ACCESSOR with a getter and no setter, exactly
    // as Electron exposes it. Modelled here because that is what broke the
    // first cut: a plain assignment to it is silently dropped, so the shim ran,
    // reported nothing wrong, and left the native inert event in place.
    get onChanged(): { addListener: (fn: unknown) => void; native: true } {
      return nativeEvent
    }
  }
}

interface Installed {
  chrome: { storage: Record<string, unknown> }
  local: FakeArea
  session: FakeArea
  reports: Array<{ area: string; saved: string[]; removed: string[] }>
  listening: boolean[]
  push: (payload: unknown) => void
}

function install(source: string, initial: Record<string, unknown> = {}): Installed {
  const local = fakeArea(initial)
  const session = fakeArea(initial)
  const chrome = {
    storage: {
      local,
      session,
      sync: local, // the lib aliases both to the SAME object
      managed: local,
      onChanged: { addListener: () => {}, native: true }
    }
  }
  const fakeGlobal: Record<string, unknown> = { chrome }
  const reports: Array<{ area: string; saved: string[]; removed: string[] }> = []
  const listening: boolean[] = []
  let handler: ((payload: unknown) => void) | null = null
  const bridge = {
    report: (area: string, saved: string[], removed: string[]) =>
      reports.push({ area, saved, removed }),
    listening: (on: boolean) => listening.push(on),
    register: (fn: (payload: unknown) => void) => {
      handler = fn
    }
  }
  const make = new Function('globalThis', `return ${source}`) as (
    g: unknown
  ) => (bridge: unknown) => void
  make(fakeGlobal)(bridge)
  return {
    chrome: chrome as unknown as { storage: Record<string, unknown> },
    local,
    session,
    reports,
    listening,
    push: (payload: unknown) => handler?.(payload)
  }
}

const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 0))

type EventLike = {
  onChanged: {
    addListener: (fn: unknown) => void
    removeListener: (fn: unknown) => void
    native?: true
  }
}

describe('the worker half, running', () => {
  it('dispatches a delivery to the area and the all-areas listener', () => {
    const it_ = install(STORAGE_WORKER_MAIN_WORLD)
    const onArea: unknown[][] = []
    const onAny: unknown[][] = []
    ;(it_.chrome.storage.session as EventLike).onChanged.addListener((...args: unknown[]) =>
      onArea.push(args)
    )
    ;(it_.chrome.storage.onChanged as { addListener: (fn: unknown) => void }).addListener(
      (...args: unknown[]) => onAny.push(args)
    )
    it_.push({ area: 'session', saved: ['k'], removed: [] })
    expect(onArea).toHaveLength(1)
    expect(onAny).toHaveLength(1)
    expect(onAny[0][1]).toBe('session') // Chrome names the area second
  })

  it('marks a saved key with newValue present and a removed key without it', () => {
    // 'newValue' in change is Chrome's save-vs-remove test, and the only part
    // of the change shape this bridge promises to be exact about.
    const it_ = install(STORAGE_WORKER_MAIN_WORLD)
    let seen: Record<string, object> = {}
    ;(it_.chrome.storage.local as EventLike).onChanged.addListener((c: unknown) => {
      seen = c as Record<string, object>
    })
    it_.push({ area: 'local', saved: ['kept'], removed: ['gone'] })
    expect(Object.keys(seen).sort()).toEqual(['gone', 'kept'])
    expect('newValue' in seen.kept).toBe(true)
    expect('newValue' in seen.gone).toBe(false)
  })

  it('carries no value at all — never oldValue, never a real newValue', () => {
    const it_ = install(STORAGE_WORKER_MAIN_WORLD)
    let seen: Record<string, Record<string, unknown>> = {}
    ;(it_.chrome.storage.local as EventLike).onChanged.addListener((c: unknown) => {
      seen = c as Record<string, Record<string, unknown>>
    })
    it_.push({ area: 'local', saved: ['k'], removed: [] })
    expect('oldValue' in seen.k).toBe(false)
    expect(seen.k.newValue).toBeUndefined()
  })

  it('does not leak a session change into the local listener', () => {
    const it_ = install(STORAGE_WORKER_MAIN_WORLD)
    const seen: unknown[] = []
    ;(it_.chrome.storage.local as EventLike).onChanged.addListener((c: unknown) => seen.push(c))
    it_.push({ area: 'session', saved: ['k'], removed: [] })
    expect(seen).toEqual([])
  })

  it('replaces the inert native events', () => {
    const it_ = install(STORAGE_WORKER_MAIN_WORLD)
    expect((it_.chrome.storage.onChanged as { native?: true }).native).toBeUndefined()
    expect((it_.chrome.storage.session as EventLike).onChanged.native).toBeUndefined()
  })

  it('survives a listener that throws', () => {
    const it_ = install(STORAGE_WORKER_MAIN_WORLD)
    const seen: unknown[] = []
    const area = it_.chrome.storage.session as EventLike
    area.onChanged.addListener(() => {
      throw new Error('boom')
    })
    area.onChanged.addListener((c: unknown) => seen.push(c))
    it_.push({ area: 'session', saved: ['k'], removed: [] })
    expect(seen).toHaveLength(1)
  })

  it('announces at startup, then on every edge and only on edges', () => {
    // The gate that keeps an extension ignoring storage from paying anything.
    // The startup "false" matters: main treats a worker it never heard from as
    // listening, so this is what makes a silent extension free.
    const it_ = install(STORAGE_WORKER_MAIN_WORLD)
    expect(it_.listening).toEqual([false])
    it_.listening.length = 0
    const area = it_.chrome.storage.session as EventLike
    const first = (): void => {}
    const second = (): void => {}
    area.onChanged.addListener(first)
    area.onChanged.addListener(second)
    expect(it_.listening).toEqual([true]) // one edge, not one per listener
    area.onChanged.removeListener(first)
    expect(it_.listening).toEqual([true])
    area.onChanged.removeListener(second)
    expect(it_.listening).toEqual([true, false])
  })

  it('ignores a delivery when nothing is listening', () => {
    const it_ = install(STORAGE_WORKER_MAIN_WORLD)
    expect(() => it_.push({ area: 'session', saved: ['k'], removed: [] })).not.toThrow()
  })

  it('reports its own writes, so a worker sees them like Chrome fires them', async () => {
    const it_ = install(STORAGE_WORKER_MAIN_WORLD, { k: 'old' })
    await (it_.chrome.storage.session as FakeArea).set({ k: 'new' })
    await settle()
    expect(it_.reports).toEqual([{ area: 'session', saved: ['k'], removed: [] }])
  })
})

describe('the frame half, running', () => {
  it('reports a write and leaves the native events alone', async () => {
    const it_ = install(STORAGE_FRAME_MAIN_WORLD, { k: 'old' })
    expect((it_.chrome.storage.onChanged as { native?: true }).native).toBe(true)
    expect((it_.chrome.storage.session as EventLike).onChanged.native).toBe(true)
    await (it_.chrome.storage.session as FakeArea).set({ k: 'new' })
    await settle()
    expect(it_.reports).toEqual([{ area: 'session', saved: ['k'], removed: [] }])
  })
})

describe('the write wrapper', () => {
  it('never reads before a write — the write is the only call it makes', () => {
    // The first cut read the old value on the way in, which put a 1.45 MB read
    // and a multi-megabyte ipc hop on Bitwarden's hot path.
    const it_ = install(STORAGE_FRAME_MAIN_WORLD, { k: 'old' })
    void (it_.chrome.storage.session as FakeArea).set({ k: 'new' })
    expect(it_.session.calls).toEqual(['set'])
    expect(it_.session.data).toEqual({ k: 'new' })
  })

  it('reports a remove by key', async () => {
    const it_ = install(STORAGE_FRAME_MAIN_WORLD, { a: 1, b: 2 })
    await (it_.chrome.storage.local as FakeArea).remove(['a'])
    await settle()
    expect(it_.reports).toEqual([{ area: 'local', saved: [], removed: ['a'] }])
  })

  it('reports a clear as every key the area held, read before the wipe', async () => {
    const it_ = install(STORAGE_FRAME_MAIN_WORLD, { a: 1, b: 2 })
    await (it_.chrome.storage.local as FakeArea).clear()
    await settle()
    expect(it_.reports).toEqual([{ area: 'local', saved: [], removed: ['a', 'b'] }])
    expect(it_.local.calls).toEqual(['get', 'clear'])
  })

  it('says nothing when a write touches no key', async () => {
    const it_ = install(STORAGE_FRAME_MAIN_WORLD)
    await (it_.chrome.storage.local as FakeArea).set({})
    await (it_.chrome.storage.local as FakeArea).clear()
    await settle()
    expect(it_.reports).toEqual([])
  })

  it('still calls a trailing callback, Chrome-style', async () => {
    const it_ = install(STORAGE_FRAME_MAIN_WORLD)
    let called = false
    const returned = (it_.chrome.storage.local as FakeArea).set({ k: 1 }, () => {
      called = true
    })
    expect(returned).toBeUndefined() // Chrome returns nothing in callback form
    await settle()
    expect(called).toBe(true)
    expect(it_.reports).toHaveLength(1)
  })

  it('wraps the aliased sync/managed area only once', async () => {
    const it_ = install(STORAGE_FRAME_MAIN_WORLD)
    // chrome.storage.sync IS chrome.storage.local here; a single write through
    // it must produce a single report, named after the real area.
    await (it_.chrome.storage.sync as FakeArea).set({ k: 1 })
    await settle()
    expect(it_.reports).toEqual([{ area: 'local', saved: ['k'], removed: [] }])
  })
})
