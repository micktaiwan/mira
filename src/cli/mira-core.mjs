/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Return types are documented via JSDoc @returns below; the TS-oriented lint
// rule can't be satisfied in a plain-ESM (.mjs) file that ships without a build.
//
// Pure logic for the `mira` CLI (bin/mira). No I/O here — everything in this
// module is a pure function so it is unit-testable without a running Mira or a
// real socket. The bin does the socket I/O and calls into these helpers.
//
// Why a CLI at all: driving Mira from a shell used to mean hand-building JSON,
// dodging the `nc` async-read trap with a throwaway Python client, and running
// list-tabs → filter → tabId by hand before every exec-js. This wraps the
// existing control socket (docs/socket.md) so those become one short command.
//
// Statefulness is carried in the ENVIRONMENT, never a shared file: MIRA_TAB
// pins "the tab to work on" for the calling shell/session only, so parallel
// Claude sessions never clobber each other's target (the recurring hazard in
// this repo). Precedence mirrors the existing --profile/MIRA_PROFILE pair:
//   --tab <id>  >  $MIRA_TAB  >  (nothing → the focused window's active tab)

/** Flags that take no value (their presence alone means `true`). Every other
 * `--flag` consumes the next token as its value unless that token is itself a
 * flag. Keeping this explicit avoids `--json tabs` swallowing `tabs`. */
export const BOOLEAN_FLAGS = new Set(['json', 'active', 'help', 'new-tab', 'full', 'background'])

/** Single-letter short flags, mapped to their long boolean name. `-n` == `--new-tab`.
 * A bare `-` is NOT a short flag: it stays a positional (e.g. `mira exec -` = stdin). */
export const SHORT_FLAGS = new Map([
  ['n', 'new-tab'],
  ['b', 'background']
])

/** True when the caller asked for a hidden tab (`--background` / `-b`): the new
 * tab loads without the window switching onto it. Mira never comes to the
 * foreground for a CLI command either way — this is only about the tab.
 *
 * @param {Record<string, string|boolean>} flags
 * @returns {boolean}
 */
export function background(flags) {
  return flags?.background === true
}

/** Registry commands that accept a `tabId` param (see docs/socket.md). Only for
 * these does a resolved tab target get injected into params — injecting `tabId`
 * into e.g. select-tab (which wants `id`) would be wrong. */
export const TAB_BOUND = new Set([
  'exec-js',
  'collect-media',
  'download-media',
  'press-key',
  'get-console',
  'screenshot'
])

/**
 * Parse an argv tail (already stripped of node + script path) into a command,
 * its positional args, and its flags.
 *
 * @param {string[]} argv
 * @returns {{ command: string|null, positionals: string[], flags: Record<string, string|boolean> }}
 */
/** How long the CLI waits for one reply, in ms, from `--timeout <seconds>`.
 *
 * WHY IT IS A KNOB: most commands answer instantly, so 30 s is a fine default
 * for spotting a hung daemon. But a few WAIT ON A HUMAN — `list-cards` pops the
 * vault bubble and sits there until a master password is typed — and 30 s is not
 * a human timeout. Junk, zero and negative values fall back to the default
 * rather than making the CLI hang or give up instantly.
 * @param {Record<string, string|boolean>} flags
 * @returns {number}
 */
export function resolveTimeoutMs(flags) {
  const raw = flags && flags.timeout
  if (typeof raw !== 'string') return 30000
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds <= 0) return 30000
  return Math.round(seconds * 1000)
}

export function parseArgs(argv) {
  /** @type {string[]} */
  const positionals = []
  /** @type {Record<string, string|boolean>} */
  const flags = {}
  let command = null

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (tok.startsWith('--')) {
      const body = tok.slice(2)
      const eq = body.indexOf('=')
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1)
      } else if (BOOLEAN_FLAGS.has(body)) {
        flags[body] = true
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[body] = argv[++i]
      } else {
        flags[body] = true
      }
    } else if (/^-[a-zA-Z]$/.test(tok) && SHORT_FLAGS.has(tok.slice(1))) {
      // Single-letter short flag (e.g. `-n`). A bare `-` falls through to the
      // positional branch so `mira exec -` (stdin) still works.
      flags[SHORT_FLAGS.get(tok.slice(1))] = true
    } else if (command === null) {
      command = tok
    } else {
      positionals.push(tok)
    }
  }

  return { command, positionals, flags }
}

/**
 * Resolve the tab to target, by precedence: explicit --tab, then $MIRA_TAB,
 * then null (caller falls back to the focused window's active tab). An empty
 * string counts as "unset".
 *
 * @param {{ flagTab?: unknown, envTab?: unknown }} src
 * @returns {string|null}
 */
export function resolveTabId({ flagTab, envTab } = {}) {
  const pick = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
  return pick(flagTab) ?? pick(envTab) ?? null
}

/**
 * Find the single tab whose URL contains `needle`. Returns the match, or a
 * typed error so the caller can fail loudly on 0 or >1 (never guess).
 *
 * @param {Array<{id:string,url?:string,title?:string}>} tabs
 * @param {string} needle
 * @returns {{ tab: {id:string,url?:string,title?:string} } | { error: string, matches?: Array<{id:string,url?:string}> }}
 */
export function pickTabByUrl(tabs, needle) {
  if (typeof needle !== 'string' || needle === '') return { error: 'empty url filter' }
  const matches = (tabs ?? []).filter((t) => (t.url ?? '').includes(needle))
  if (matches.length === 0) return { error: `no tab matching "${needle}"` }
  if (matches.length > 1)
    return { error: `ambiguous "${needle}" (${matches.length} tabs)`, matches }
  return { tab: matches[0] }
}

/**
 * Build the exec-js request. A missing/empty tabId means "active tab" — the
 * registry decides. A stale tabId is NOT swapped for the active tab here: it is
 * passed through so the registry replies `unknown tab: <id>` and we fail loudly.
 *
 * @param {string} code
 * @param {string|null} tabId
 * @returns {{ command: 'exec-js', params: { code: string, tabId?: string } }}
 */
export function buildExec(code, tabId) {
  const params = { code }
  if (tabId) params.tabId = tabId
  return { command: 'exec-js', params }
}

/**
 * Build the navigate request. The resolved tab travels as `tabId`, so a session
 * pinned with `--tab` / `$MIRA_TAB` navigates THAT tab even while another window
 * holds focus — before this, `nav` was the one page-bound verb that dropped its
 * target and loaded into the focused window's active tab, silently overwriting
 * whatever page was there.
 *
 * With `newTab`, the same id names the tab the new one opens next to (which is
 * what picks the window); a stale id is passed through untouched so the registry
 * answers `unknown tab: <id>` rather than us guessing a replacement.
 *
 * @param {string} url
 * @param {string|null} tabId
 * @param {{ newTab?: boolean, background?: boolean }} [opts]
 * @returns {{ command: 'navigate', params: object }}
 */
export function buildNav(url, tabId, opts = {}) {
  const params = { url }
  if (opts.newTab) params.newTab = true
  if (opts.newTab && opts.background) params.background = true
  if (tabId) params.tabId = tabId
  return { command: 'navigate', params }
}

/**
 * Build the focus-app request. `windowId` (from `mira windows`) picks WHICH
 * window comes to the front; without it Mira raises its last-focused one, which
 * with several windows open is rarely the one the caller means.
 *
 * @param {string|boolean|undefined} windowId  raw value of --window
 * @returns {{ command: 'focus-app', params?: { windowId: string } }}
 */
export function buildFocus(windowId) {
  if (typeof windowId === 'string' && windowId.trim() !== '') {
    return { command: 'focus-app', params: { windowId: windowId.trim() } }
  }
  return { command: 'focus-app' }
}

/**
 * Reload plan. `reload` takes a tabId, so a pinned tab is reloaded server-side.
 *
 * It used to go through exec-js (`location.reload()`) for lack of that param,
 * which was wrong on the error page: that page is a data: URL, so reloading it
 * from inside re-rendered the error instead of retrying the URL that failed.
 * The command handles that case (see NavContext.retryFailedLoad).
 *
 * @param {string|null} tabId
 * @returns {{ command: string, params?: object }}
 */
export function buildReload(tabId) {
  if (tabId) return { command: 'reload', params: { tabId } }
  return { command: 'reload' }
}

/**
 * Press-key plan: send a real keypress to the pinned/active tab. `modifiers` is
 * a list of alt|ctrl|meta|shift. The target tab is activated first server-side,
 * so a background tab is brought forward rather than silently dropping the key.
 *
 * @param {string} key
 * @param {string|null} tabId
 * @param {string[]} [modifiers]
 * @returns {{ request: {command:string, params:object} } | { error: string }}
 */
export function buildPress(key, tabId, modifiers) {
  if (typeof key !== 'string' || key === '') return { error: 'press needs a key' }
  const params = { key }
  if (tabId) params.tabId = tabId
  if (modifiers && modifiers.length > 0) params.modifiers = modifiers
  return { request: { command: 'press-key', params } }
}

/**
 * get-console plan: read the captured web-page console of the pinned/active tab
 * (or an explicit tabId). Optional --level floors severity and --limit caps the
 * count; both arrive as strings from the CLI and are passed through as-is (a bad
 * value is rejected server-side with a clear error).
 *
 * @param {string|null} tabId
 * @param {{ level?: unknown, limit?: unknown, since?: unknown }} [opts]
 * @returns {{ command: string, params: object }}
 */
export function buildConsole(tabId, opts = {}) {
  const params = {}
  if (tabId) params.tabId = tabId
  if (typeof opts.level === 'string' && opts.level !== '') params.minLevel = opts.level
  if (opts.limit !== undefined && opts.limit !== '') params.limit = Number(opts.limit)
  if (opts.since !== undefined && opts.since !== '') params.sinceSeq = Number(opts.since)
  return { command: 'get-console', params }
}

/**
 * Human-readable rendering of a get-console result: one line per captured entry,
 * `seq  LEVEL  [source]  message` with the source url appended when present. An
 * empty capture renders as a friendly note rather than a blank.
 *
 * @param {Array<{seq:number,level:string,source:string,message:string,url?:string,lineNumber?:number}>} messages
 * @returns {string}
 */
export function formatConsole(messages) {
  const list = messages ?? []
  if (list.length === 0) return '(no console output captured for this tab)'
  return list
    .map((m) => {
      const level = String(m.level ?? '')
        .toUpperCase()
        .padEnd(7)
      const src = m.source ? `[${m.source}] ` : ''
      const where = m.url ? `  (${m.url}${m.lineNumber ? ':' + m.lineNumber : ''})` : ''
      const msg = String(m.message ?? '').replace(/\s+$/, '')
      return `${String(m.seq).padStart(4)}  ${level}${src}${msg}${where}`
    })
    .join('\n')
}

/**
 * Human-readable rendering of a list-windows result: one line per window with
 * its id, profile, tab count, and a `*` on the focused one.
 *
 * @param {Array<{windowId:string,profileId:string,tabCount:number,focused:boolean}>} windows
 * @returns {string}
 */
export function formatWindows(windows) {
  return (windows ?? [])
    .map((w) => {
      const mark = w.focused ? '*' : ' '
      const prof = (w.profileId ?? '').slice(0, 12).padEnd(12)
      return `${mark} ${w.windowId}  prof=${prof}  tabs=${w.tabCount}`
    })
    .join('\n')
}

/**
 * Assemble a generic passthrough request: a command name plus params from a
 * `--params '<json>'` flag, with `tabId` injected only for TAB_BOUND commands
 * when a tab is resolved and the caller did not already set one.
 *
 * @param {string} command
 * @param {string|boolean|undefined} paramsJson  raw value of --params
 * @param {string|null} tabId
 * @returns {{ request: {command:string, params?:object} } | { error: string }}
 */
export function buildCall(command, paramsJson, tabId) {
  let params = {}
  if (typeof paramsJson === 'string' && paramsJson.trim() !== '') {
    try {
      params = JSON.parse(paramsJson)
    } catch {
      return { error: `--params is not valid JSON: ${paramsJson}` }
    }
    if (params === null || typeof params !== 'object' || Array.isArray(params)) {
      return { error: '--params must be a JSON object' }
    }
  }
  if (tabId && TAB_BOUND.has(command) && params.tabId === undefined) {
    params.tabId = tabId
  }
  const request = Object.keys(params).length > 0 ? { command, params } : { command }
  return { request }
}

/**
 * Human-readable one-line-per-tab rendering of a list-tabs result. The active
 * (visible) tab is marked with `*`; a tab that is asleep/discarded (`loaded ===
 * false`, so page-bound commands would fail until it is woken) with `z`; the
 * rest with a space. Knowing a tab is asleep up front saves a failed round-trip.
 * A second column marks a tab currently playing sound with `♪` (TabInfo.audible)
 * — the from-the-shell answer to "which tab is making noise?".
 *
 * Then three age columns — opened / last focused / last changed — as compact
 * durations ("3d", "4h", "-" when the tab carries no such timestamp). Ages, not
 * dates: the question they answer is "what has been sitting here forever and was
 * never looked at?", and a duration answers it without any arithmetic.
 *
 * @param {Array<{id:string,url?:string,title?:string,loaded?:boolean,audible?:boolean,openedAt?:number|null,lastActiveAt?:number|null,updatedAt?:number|null}>} tabs
 * @param {string} [activeId]
 * @param {number} [now] epoch ms the ages are measured from (defaults to the clock)
 * @returns {string}
 */
export function formatTabs(tabs, activeId, now = Date.now()) {
  return (tabs ?? [])
    .map((t) => {
      const mark = t.id === activeId ? '*' : t.loaded === false ? 'z' : ' '
      const sound = t.audible === true ? '♪' : ' '
      const ages = [t.openedAt, t.lastActiveAt, t.updatedAt]
        .map((at) => formatAge(at, now).padStart(4))
        .join(' ')
      const title = (t.title ?? '').slice(0, 40).padEnd(40)
      return `${mark}${sound} ${t.id}  ${ages}  ${title}  ${t.url ?? ''}`
    })
    .join('\n')
}

/**
 * How long ago `at` (epoch ms) was, in one compact unit: `12s`, `5m`, `4h`,
 * `23d`. Null/absent/future stamps print `-` — a tab with no timestamp must not
 * read as freshly touched, and a clock that went backwards is not an age.
 *
 * @param {number|null|undefined} at
 * @param {number} now
 * @returns {string}
 */
export function formatAge(at, now) {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return '-'
  const s = Math.floor((now - at) / 1000)
  if (s < 0) return '-'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/**
 * One line of the focus stream, for a human watching `mira watch`.
 *
 * `null` (nobody is in Mira) prints as a dash rather than disappearing: the
 * whole point of the stream is that leaving the browser is an event too.
 *
 * @param {object|null} tab
 * @returns {string}
 */
export function formatFocus(tab) {
  if (!tab) return '-  (Mira not frontmost)'
  const where = tab.folderTitle ? `${tab.profileLabel} / ${tab.folderTitle}` : tab.profileLabel
  const title = (tab.title ?? '').slice(0, 40).padEnd(40)
  return `[${where}]  ${title}  ${tab.url ?? ''}`
}

/**
 * Read exec-js code from a positional arg, `-` (stdin), or `@path` (file). The
 * actual reads are injected so this stays pure and testable.
 *
 * @param {string|undefined} arg
 * @param {{ readStdin: () => string, readFile: (p: string) => string }} io
 * @returns {{ code: string } | { error: string }}
 */
export function resolveCode(arg, io) {
  if (arg === undefined || arg === '') return { error: 'no code given' }
  if (arg === '-') return { code: io.readStdin() }
  if (arg.startsWith('@')) {
    try {
      return { code: io.readFile(arg.slice(1)) }
    } catch (e) {
      return { error: `cannot read ${arg.slice(1)}: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
  return { code: arg }
}

/**
 * screenshot plan: capture the pinned/active tab into a PNG file.
 *
 * The path is made absolute HERE, in the caller's shell, because that is the
 * only side that knows its working directory — Mira's own cwd is wherever the
 * app was launched from, and the daemon refuses a relative path for exactly
 * that reason. A leading `~/` is expanded too, so a quoted "~/shot.png" (which
 * the shell leaves alone) still lands in the home directory.
 *
 * @param {string|undefined} pathArg
 * @param {string|null} tabId
 * @param {{ full?: boolean, cwd: string, home: string }} env
 * @returns {{ request: {command:string, params:object} }}
 */
export function buildScreenshot(pathArg, tabId, env) {
  const params = {}
  if (typeof pathArg === 'string' && pathArg.trim() !== '') {
    params.path = absolutePath(pathArg.trim(), env)
  }
  if (tabId) params.tabId = tabId
  if (env.full === true) params.fullPage = true
  return { request: { command: 'screenshot', params } }
}

/**
 * Make one path absolute against a home and a working directory. Pure (no fs,
 * no process): `~` and `~/x` expand to the home, an absolute path is untouched,
 * anything else hangs off cwd. Kept naive on purpose — no symlink or `..`
 * resolution, which is the kernel's job at write time.
 *
 * @param {string} p
 * @param {{ cwd: string, home: string }} env
 * @returns {string}
 */
export function absolutePath(p, { cwd, home }) {
  if (p === '~') return home
  if (p.startsWith('~/')) return `${home.replace(/\/$/, '')}/${p.slice(2)}`
  if (p.startsWith('/')) return p
  return `${cwd.replace(/\/$/, '')}/${p.replace(/^\.\//, '')}`
}

/**
 * Human-readable rendering of a screenshot result: the path, the pixel size and
 * the file size, with the truncation called out when the page was too tall to
 * capture whole (silence there would pass a partial image off as the full one).
 *
 * @param {{path:string,width:number,height:number,bytes:number,fullPage?:boolean,clamped?:boolean}} res
 * @returns {string}
 */
export function formatScreenshot(res) {
  const kb = Math.round((res.bytes ?? 0) / 1024)
  const scope = res.fullPage ? 'full page' : 'viewport'
  const cut = res.clamped ? ' — CUT OFF: the page is taller than a capture can be' : ''
  return `${res.path}  ${res.width}×${res.height}  ${kb} KB  (${scope})${cut}`
}

/**
 * Decide which window a `nav` / `open` may target, and REFUSE to guess.
 *
 * Why this exists. `navigate` without a `tabId` acts on the caller's window,
 * which for a socket call means the FOCUSED one — and a CLI call from a
 * terminal focuses nothing, so Mira falls back to the first window it holds.
 * With one profile that is harmless. With several it is a privacy leak: on
 * 2026-08-28 a bank page from the personal profile opened in the work profile,
 * because the work window happened to be first. Nothing in the request was
 * wrong; the fallback simply invented a target.
 *
 * So: when the open windows span more than one profile and the caller named no
 * target, we fail loudly instead of picking. A single profile stays frictionless.
 *
 * `labels` maps profile id -> human label ("perso: …", "pro: lempire"). It is
 * what makes both the matching and the error message usable: profile ids are
 * opaque UUIDs, so `--profile perso` matches the label, and the refusal names
 * the profiles the way Mickael names them rather than printing three UUIDs.
 *
 * @param {Array<{windowId:string,profileId:string,tabCount:number,focused:boolean}>} windows
 * @param {{ tabId?: string|null, windowFlag?: string|boolean, profileFlag?: string|boolean }} opts
 * @param {Record<string,string>} [labels]  profile id -> label
 * @returns {{ windowId: string|null } | { error: string }}
 */
export function resolveNavTarget(windows, opts = {}, labels = {}) {
  const list = windows ?? []
  const nameOf = (id) => (labels[id] ? `${labels[id]} [${id}]` : id)
  // A pinned tab already names its window; nothing to resolve.
  if (opts.tabId) return { windowId: null }

  if (typeof opts.windowFlag === 'string' && opts.windowFlag.trim() !== '') {
    const id = opts.windowFlag.trim()
    const hit = list.find((w) => w.windowId === id)
    if (!hit) return { error: `unknown window: ${id}` }
    return { windowId: hit.windowId }
  }

  if (typeof opts.profileFlag === 'string' && opts.profileFlag.trim() !== '') {
    const needle = opts.profileFlag.trim().toLowerCase()
    // Match on the id prefix OR anywhere in the label, so `--profile perso`
    // works without anyone having to carry a UUID around.
    const hits = list.filter((w) => {
      const id = (w.profileId ?? '').toLowerCase()
      const label = (labels[w.profileId] ?? '').toLowerCase()
      return id.startsWith(needle) || label.includes(needle)
    })
    if (hits.length === 0) return { error: `no open window for profile: ${opts.profileFlag}` }
    const distinct = [...new Set(hits.map((w) => w.profileId))]
    if (distinct.length > 1) {
      const lines = distinct.map((id) => `  ${nameOf(id)}`).join('\n')
      return {
        error: `"${opts.profileFlag}" matches several profiles; be more specific:\n${lines}`
      }
    }
    if (hits.length > 1) {
      const lines = hits.map((w) => `  ${w.windowId}  tabs=${w.tabCount}`).join('\n')
      return {
        error: `profile ${nameOf(distinct[0])} has several windows; pass --window <id>:\n${lines}`
      }
    }
    return { windowId: hits[0].windowId }
  }

  const profiles = [...new Set(list.map((w) => w.profileId ?? ''))]
  if (profiles.length <= 1) return { windowId: null }

  const lines = list
    .map((w) => `  ${w.windowId}  tabs=${w.tabCount}  ${nameOf(w.profileId)}`)
    .join('\n')
  return {
    error:
      `refusing to guess a window: ${profiles.length} profiles are open, and a CLI call focuses none.\n` +
      `Name the target — --tab <id> (or $MIRA_TAB), --window <id>, or --profile <label|id>:\n` +
      lines
  }
}
