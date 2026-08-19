// Form memory, assembled: the page agent on one side, a small JSON file on the
// other, and the pure rules of form-memory.ts in between.
//
// The whole flow: a frame reports a field that lost focus -> the main process
// resolves which PROFILE it belongs to (values never cross profiles) and which
// registrable domain the frame is on -> shouldRemember decides -> the value joins
// that field's MRU list -> the file is rewritten, debounced. On the next focus,
// the frame asks for the field's values and Chromium's datalist popup does the
// rest.
//
// Storage is userData/form-memory.json, one file for every profile (keyed by
// profile id inside), next to card-vaults.json. Nothing secret is in it by
// construction — passwords, one-time codes and cards are refused upstream — but
// it is still plain profile data: a value typed in an encrypted profile is the
// one thing this file must not outlive, hence forgetProfile().

import { ipcMain, type Session } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  fieldKey,
  forgetEntries,
  listEntries,
  memoryDomain,
  parseMemory,
  rememberValue,
  serializeMemory,
  shouldRemember,
  suggestionsFor,
  type FormMemory,
  type FormMemoryEntry
} from './form-memory'
import {
  FORM_MEMORY_PRELOAD_SOURCE,
  FORM_MEMORY_RECORD_CHANNEL,
  FORM_MEMORY_SUGGEST_CHANNEL
} from './form-memory-shim'
import type { FieldAttrs } from './card-capture'

/** What a frame sends: the field's attributes, what is in it, and where it is. */
export interface FormMemoryPayload {
  attrs: FieldAttrs
  value: string
  url: string
}

/** Which profile a reporting frame belongs to. Structurally the same object the
 * card pipeline resolves (card-capture-service.ts), so profiles.ts hands both
 * pipelines the same resolver. */
export interface FormMemorySource {
  profileId: string
}

export interface FormMemoryDeps {
  now?: () => number
  /** Overridable for tests; defaults to userData/form-memory.json. */
  load?: () => FormMemory
  persist?: (memory: FormMemory) => void
  /** Disk-write debounce. */
  debounceMs?: number
}

/** Cap on what a frame may send, applied before anything else looks at it: a
 * hostile page cannot make Mira hold a megabyte of "value". */
const MAX_INCOMING = 400

/** Coerce whatever arrived over ipc into a payload, or null. Exported because
 * this is the trust boundary and it is what the tests pin. */
export function normalizePayload(raw: unknown): FormMemoryPayload | null {
  const p = raw as { attrs?: unknown; value?: unknown; url?: unknown } | null
  if (!p || typeof p !== 'object') return null
  if (typeof p.value !== 'string' && p.value !== undefined) return null
  const rawAttrs = (p.attrs ?? {}) as Record<string, unknown>
  if (typeof rawAttrs !== 'object' || rawAttrs === null) return null

  const text = (key: string): string | undefined => {
    const value = rawAttrs[key]
    return typeof value === 'string' ? value.slice(0, MAX_INCOMING) : undefined
  }
  const attrs: FieldAttrs = {
    ...(text('autocomplete') !== undefined ? { autocomplete: text('autocomplete') } : {}),
    ...(text('name') !== undefined ? { name: text('name') } : {}),
    ...(text('id') !== undefined ? { id: text('id') } : {}),
    ...(text('placeholder') !== undefined ? { placeholder: text('placeholder') } : {}),
    ...(text('ariaLabel') !== undefined ? { ariaLabel: text('ariaLabel') } : {}),
    ...(text('label') !== undefined ? { label: text('label') } : {}),
    ...(text('type') !== undefined ? { type: text('type') } : {})
  }
  return {
    attrs,
    value: typeof p.value === 'string' ? p.value.slice(0, MAX_INCOMING) : '',
    url: typeof p.url === 'string' ? p.url.slice(0, 2048) : ''
  }
}

export class FormMemoryService {
  private memory: FormMemory
  private timer: ReturnType<typeof setTimeout> | null = null
  private preloadPath: string | null = null
  private readonly attached = new WeakSet<Session>()
  private ipcInstalled = false
  private readonly now: () => number
  private readonly debounceMs: number

  constructor(
    private readonly userDataDir: string,
    private readonly deps: FormMemoryDeps = {}
  ) {
    this.now = deps.now ?? Date.now
    this.debounceMs = deps.debounceMs ?? 1000
    this.memory = (deps.load ?? (() => this.loadFromDisk()))()
  }

  /** Install the page agent on a profile's web session (once per session) and the
   * ipc handlers (once). Unlike cards, EVERY profile gets this: there is no
   * mapping to opt into, remembering a field is what the browser is for. */
  attach(ses: Session, resolve: (webContentsId: number) => FormMemorySource | null): void {
    this.installIpc(resolve)
    if (this.attached.has(ses)) return
    this.attached.add(ses)
    ses.registerPreloadScript({
      id: 'mira-form-memory',
      type: 'frame',
      filePath: this.ensurePreload()
    })
  }

  /** One reported field. Returns what happened, which is what the tests assert
   * on: 'ignored' (not a field worth keeping, or not a web page) or
   * 'remembered'. */
  record(
    profileId: string,
    payload: FormMemoryPayload,
    frameUrl?: string
  ): 'ignored' | 'remembered' {
    const domain = memoryDomain(frameUrl || payload.url)
    const field = fieldKey(payload.attrs)
    if (!domain || !field) return 'ignored'
    if (!shouldRemember(payload.attrs, payload.value)) return 'ignored'

    const next = rememberValue(this.memory, {
      profileId,
      domain,
      field,
      value: payload.value,
      now: this.now()
    })
    if (next === this.memory) return 'ignored'
    this.memory = next
    this.schedulePersist()
    return 'remembered'
  }

  /** What to offer in this field, most recently used first. Empty for a field
   * that would not be remembered in the first place, so the popup never appears
   * on a password box. */
  suggest(profileId: string, payload: FormMemoryPayload, frameUrl?: string): string[] {
    const domain = memoryDomain(frameUrl || payload.url)
    const field = fieldKey(payload.attrs)
    if (!domain || !field) return []
    // '' passes the value checks in shouldRemember only through this dummy: what
    // matters here is the FIELD (a password/card field must never be offered).
    if (!shouldRemember(payload.attrs, 'xx')) return []
    return suggestionsFor(this.memory, { profileId, domain, field })
  }

  // ── command context ──────────────────────────────────────────────────────

  /** Record a value as if it had been typed on that page. The socket path
   * (`remember-form-value`) and the page path go through the SAME rule, so what
   * a test drives is what a real form does. */
  rememberTyped(params: { profileId: string; url: string; field: string; value: string }): {
    profileId: string
    domain: string
    field: string
    remembered: boolean
  } {
    const payload: FormMemoryPayload = {
      attrs: { name: params.field, type: 'text' },
      value: params.value,
      url: params.url
    }
    const outcome = this.record(params.profileId, payload)
    return {
      profileId: params.profileId,
      domain: memoryDomain(params.url),
      field: fieldKey(payload.attrs) ?? '',
      remembered: outcome === 'remembered'
    }
  }

  /** What the popup would offer for that field on that page. */
  suggestFor(params: { profileId: string; url: string; field: string }): {
    profileId: string
    domain: string
    field: string
    values: string[]
  } {
    const payload: FormMemoryPayload = {
      attrs: { name: params.field, type: 'text' },
      value: '',
      url: params.url
    }
    return {
      profileId: params.profileId,
      domain: memoryDomain(params.url),
      field: fieldKey(payload.attrs) ?? '',
      values: this.suggest(params.profileId, payload)
    }
  }

  list(filter: { profileId?: string; domain?: string } = {}): FormMemoryEntry[] {
    return listEntries(this.memory, filter)
  }

  /** Forget one value, a field, a domain or a whole profile — whichever is the
   * narrowest thing named. */
  forget(filter: { profileId: string; domain?: string; field?: string; value?: string }): {
    removed: number
  } {
    const { memory, removed } = forgetEntries(this.memory, filter)
    if (removed > 0) {
      this.memory = memory
      this.schedulePersist()
    }
    return { removed }
  }

  /** Drop everything a profile ever typed (profile deleted, "forget this
   * profile"). */
  forgetProfile(profileId: string): { removed: number } {
    return this.forget({ profileId })
  }

  /** Write now, for quit. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.persist()
  }

  // ── internals ────────────────────────────────────────────────────────────

  private installIpc(resolve: (webContentsId: number) => FormMemorySource | null): void {
    if (this.ipcInstalled) return
    this.ipcInstalled = true

    ipcMain.on(FORM_MEMORY_RECORD_CHANNEL, (event, raw) => {
      const source = resolve(event.sender.id)
      const payload = normalizePayload(raw)
      if (!source || !payload) return
      this.record(source.profileId, payload, event.senderFrame?.url)
    })

    ipcMain.handle(FORM_MEMORY_SUGGEST_CHANNEL, (event, raw) => {
      const source = resolve(event.sender.id)
      const payload = normalizePayload(raw)
      if (!source || !payload) return []
      return this.suggest(source.profileId, payload, event.senderFrame?.url)
    })
  }

  private ensurePreload(): string {
    if (this.preloadPath) return this.preloadPath
    const dir = join(this.userDataDir, 'sw-shims')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const path = join(dir, 'form-memory.js')
    writeFileSync(path, FORM_MEMORY_PRELOAD_SOURCE, 'utf8')
    return (this.preloadPath = path)
  }

  private get file(): string {
    return join(this.userDataDir, 'form-memory.json')
  }

  private loadFromDisk(): FormMemory {
    try {
      if (!existsSync(this.file)) return {}
      return parseMemory(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      // A corrupt file must not stop the browser from starting; it gets
      // overwritten by the next thing typed.
      return {}
    }
  }

  private schedulePersist(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.persist()
    }, this.debounceMs)
    this.timer.unref?.()
  }

  private persist(): void {
    if (this.deps.persist) {
      this.deps.persist(this.memory)
      return
    }
    try {
      if (!existsSync(this.userDataDir)) mkdirSync(this.userDataDir, { recursive: true })
      writeFileSync(this.file, serializeMemory(this.memory), 'utf8')
    } catch {
      // Losing form history is not worth a crash.
    }
  }
}
