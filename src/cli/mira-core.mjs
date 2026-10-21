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
export const BOOLEAN_FLAGS = new Set([
  'json',
  'active',
  'help',
  'new-tab',
  'full',
  'background',
  // wait: --gone flips the condition (wait for a disappearance).
  'gone',
  // click: --scroll brings an off-screen target into view before clicking.
  'scroll',
  // batch: --keep-going runs every line even after one fails.
  'keep-going',
  // tabs: --session lists this Claude session's own window.
  'session',
  // type: --focused types into the element that has focus (iframes included).
  'focused'
])

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
  'click',
  'wait-for',
  'get-console',
  'screenshot',
  'snapshot',
  'type-text',
  'select-option',
  // Both take `tabId` and resolve it across every open window (docs/socket.md).
  // Without them here, `mira close-tab --tab <id>` reached the daemon with no
  // params at all and answered `missing "id" (or "tabId")`, so the only way in
  // was `--params '{"tabId":"…"}'` — a flag nobody guesses from the error.
  'close-tab',
  'discard-tab'
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

/** CLI verbs whose target is "a tab", and so land in the agent session's own
 * window when nothing else names one (see sessionTarget). `tabs` and `use` are
 * NOT in it on purpose: they are how a session finds the pages the USER has
 * open ("look at the page I have open"), so they keep reading the focused one. */
export const SESSION_VERBS = new Set([
  'exec',
  'click',
  'snap',
  'snapshot',
  'type',
  'select',
  'wait',
  'batch',
  'press',
  'reload',
  'shot',
  'screenshot',
  'console',
  'nav',
  'navigate',
  'open'
])

/**
 * The agent session whose own window this call should land in, or null to keep
 * the old targeting. Claude Code runs every shell command in a fresh shell, so a
 * `$MIRA_TAB` pin is gone by the next call and parallel sessions all fell back to
 * the focused window — the user's, and the same one for everybody. What survives
 * between calls is CLAUDE_CODE_SESSION_ID (and CLAUDE_PID, the agent's process),
 * which Claude Code sets in each command's environment. Mira keeps one window
 * per session id (src/main/session-windows.ts).
 *
 * An explicit tab or window always wins (--tab, $MIRA_TAB, --window), and
 * MIRA_NO_SESSION_WINDOW=1 opts out. --profile does NOT opt out: it picks which
 * profile the session's window lives in (one window per profile), returned as
 * `profileFlag` for the caller to resolve with matchProfileId. `call` / a bare registry name only counts
 * when that command takes a tab (TAB_BOUND): `mira call list-profiles` must not
 * open a window as a side effect.
 *
 * @param {{ command: string|null, positionals?: string[], flags?: Record<string, string|boolean>, tabId?: string|null, env?: Record<string, string|undefined> }} src
 * @returns {{ sessionId: string, pid?: number, profileFlag?: string } | null}
 */
export function sessionTarget({ command, positionals = [], flags = {}, tabId, env = {} }) {
  const sessionId = (env.CLAUDE_CODE_SESSION_ID ?? '').trim()
  if (!sessionId || env.MIRA_NO_SESSION_WINDOW === '1') return null
  if (tabId || typeof flags.window === 'string') return null
  if (!command) return null
  // `mira call get-console --params '{"tabId":…}'` names its tab too: routing it
  // to the session window refused with "3 profiles are open" while the tab id
  // already said which page (and so which profile) was meant. `close-tab` and
  // `close-window` name the same thing as `id` / `windowId` (docs/socket.md), so
  // the three keys count alike: `mira call close-tab --params '{"id":…}'` hit the
  // same refusal (2026-10-20).
  if (command === 'call' && paramsTarget(flags.params)) return null
  const registryName = command === 'call' ? positionals[0] : command
  const wantsTab = SESSION_VERBS.has(command) || TAB_BOUND.has(registryName ?? '')
  if (!wantsTab) return null
  const out = { sessionId }
  const pid = Number(env.CLAUDE_PID)
  if (Number.isInteger(pid) && pid > 0) out.pid = pid
  if (typeof flags.profile === 'string' && flags.profile.trim() !== '') {
    out.profileFlag = flags.profile.trim()
  }
  return out
}

/** The target a `--params` JSON names -- `tabId`, `id` or `windowId` -- or null
 * (absent, empty, or not JSON). Only consulted for a command that takes a tab,
 * so a bare `id` there is a tab or a window, never some other object. */
function paramsTarget(params) {
  if (typeof params !== 'string') return null
  try {
    const parsed = JSON.parse(params)
    for (const key of ['tabId', 'id', 'windowId']) {
      const value = parsed?.[key]
      if (typeof value === 'string' && value.trim() !== '') return value
    }
    return null
  } catch {
    return null
  }
}

/**
 * The `find-session-window` params for `mira tabs --session`: the calling Claude
 * session's own window, never the user's. `tabs` alone keeps reading the focused
 * window (it is how a session finds the page the USER has open), so the session
 * window is opt-in. --window and --session name two different windows: refused.
 *
 * @param {{ flags?: Record<string, string|boolean>, env?: Record<string, string|undefined> }} src
 * @returns {{ sessionId: string, profileFlag?: string } | { error: string }}
 */
export function sessionTabsTarget({ flags = {}, env = {} }) {
  if (typeof flags.window === 'string') return { error: 'tabs: --session and --window conflict' }
  const sessionId = (env.CLAUDE_CODE_SESSION_ID ?? '').trim()
  if (!sessionId) {
    return { error: 'tabs --session: not inside a Claude Code session (no CLAUDE_CODE_SESSION_ID)' }
  }
  const out = { sessionId }
  if (typeof flags.profile === 'string' && flags.profile.trim() !== '') {
    out.profileFlag = flags.profile.trim()
  }
  return out
}

/**
 * Resolve a `--profile` value to ONE profile id, open or not: an id prefix or a
 * piece of the label (`--profile perso`). Zero or several matches is an error —
 * a page must never load under a guessed identity.
 *
 * @param {Array<{id:string,label?:string}>} profiles
 * @param {string} flag
 * @returns {{ id: string } | { error: string }}
 */
export function matchProfileId(profiles, flag) {
  const needle = String(flag ?? '')
    .trim()
    .toLowerCase()
  if (!needle) return { error: 'empty --profile' }
  const hits = (profiles ?? []).filter(
    (p) =>
      (p.id ?? '').toLowerCase().startsWith(needle) ||
      (p.label ?? '').toLowerCase().includes(needle)
  )
  if (hits.length === 1) return { id: hits[0].id }
  if (hits.length === 0) return { error: `no profile matches: ${flag}` }
  const exact = hits.filter((p) => (p.label ?? '').toLowerCase() === needle)
  if (exact.length === 1) return { id: exact[0].id }
  const lines = hits.map((p) => `  ${p.label ?? ''} [${p.id}]`).join('\n')
  return { error: `"${flag}" matches several profiles; be more specific:\n${lines}` }
}

/**
 * The window `mira tabs --profile <p>` lists: the profile's only open window.
 * Several windows (a tear-off) are named so the caller picks one with --window;
 * none means the profile is closed. Pure.
 *
 * @param {Array<{windowId:string,profileId:string}>} windows
 * @param {string} profileId
 * @param {string} [label]
 * @returns {{ windowId: string } | { error: string }}
 */
export function profileWindow(windows, profileId, label) {
  const name = label ? `${label} [${profileId}]` : profileId
  const owned = (windows ?? []).filter((w) => w.profileId === profileId)
  if (owned.length === 1) return { windowId: owned[0].windowId }
  if (owned.length === 0) return { error: `profile not open: ${name}` }
  const ids = owned.map((w) => `  ${w.windowId}`).join('\n')
  return { error: `profile ${name} has ${owned.length} windows; pick one with --window:\n${ids}` }
}

/**
 * The USER's window an agent's `open` / `nav` should land in instead of a fresh
 * session window: the profile's open window that is not the session's own (the
 * focused one first when there are several). Null when the profile has no window
 * of the user's open — only then is a session window worth creating. Opening a
 * page in a profile that is already on screen used to spawn one more window per
 * Claude session; the user asked for a tab in the window they already have
 * (2026-10-13). Pure.
 *
 * @param {Array<{windowId:string,profileId:string,focused?:boolean}>} windows
 * @param {string} profileId
 * @param {string|null} [sessionWindowId]  this session's own window in that profile, if any
 * @returns {string|null}
 */
export function userWindowForOpen(windows, profileId, sessionWindowId = null) {
  const owned = (windows ?? []).filter(
    (w) => w.profileId === profileId && w.windowId !== sessionWindowId
  )
  if (owned.length === 0) return null
  return (owned.find((w) => w.focused) ?? owned[0]).windowId
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
 * `labels` maps profile id -> human label ("perso: …", "pro: acme"). It is
 * what makes both the matching and the error message usable: profile ids are
 * opaque UUIDs, so `--profile perso` matches the label, and the refusal names
 * the profiles the way the user names them rather than printing three UUIDs.
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

/**
 * wait-for plan: block until a condition holds in the page. Exactly one of
 * selector / text / url / host names WHAT to wait for; `--gone` waits for it to stop
 * holding. The point is to delete `sleep` from automation scripts: a fixed sleep
 * is too long when the page is already there and too short when it is not — and
 * the short case is the dangerous one, since it reads as "the element does not
 * exist" a few hundred ms before it appears.
 *
 * @param {string|null} tabId
 * @param {{ selector?: unknown, text?: unknown, url?: unknown, host?: unknown, gone?: boolean, timeout?: unknown }} opts
 * @returns {{ request: {command:string, params:object} } | { error: string }}
 */
export function buildWait(tabId, opts = {}) {
  const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null)
  const named = [
    ['selector', str(opts.selector)],
    ['text', str(opts.text)],
    ['url', str(opts.url)],
    ['host', str(opts.host)]
  ].filter(([, v]) => v !== null)
  if (named.length === 0) return { error: 'wait needs --selector, --text, --url or --host' }
  if (named.length > 1) {
    return { error: `wait takes one condition, got ${named.map(([k]) => '--' + k).join(' and ')}` }
  }
  const params = { [named[0][0]]: named[0][1] }
  if (opts.gone === true) params.gone = true
  if (opts.timeout !== undefined && opts.timeout !== '') {
    const ms = Number(opts.timeout)
    if (!Number.isFinite(ms) || ms <= 0) return { error: `--timeout must be a number of ms` }
    params.timeoutMs = Math.round(ms)
  }
  if (tabId) params.tabId = tabId
  return { request: { command: 'wait-for', params } }
}

/**
 * click plan: a REAL mouse click (CDP), the missing third pillar next to exec-js
 * and press-key. The target is named by --selector, --text or explicit viewport
 * --at x,y; --nth picks among several matches (1-based), --scroll brings an
 * off-screen target into view rather than clicking into the void.
 *
 * @param {string|null} tabId
 * @param {{ selector?: unknown, text?: unknown, at?: unknown, nth?: unknown, scroll?: boolean }} opts
 * @returns {{ request: {command:string, params:object} } | { error: string }}
 */
export function buildClick(tabId, opts = {}) {
  const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null)
  const at = str(opts.at)
  const ref = str(opts.ref)
  const named = [
    ['selector', str(opts.selector)],
    ['text', str(opts.text)],
    ['at', at],
    ['ref', ref]
  ].filter(([, v]) => v !== null)
  if (named.length === 0) return { error: 'click needs --selector, --text, --ref <n> or --at x,y' }
  if (named.length > 1) {
    return { error: `click takes one target, got ${named.map(([k]) => '--' + k).join(' and ')}` }
  }
  const [kind, value] = named[0]
  const params = {}
  if (kind === 'ref') {
    const n = parseRef(value)
    if (typeof n !== 'number') return n
    params.ref = n
  } else if (kind === 'at') {
    const parts = value.split(',').map((n) => Number(n.trim()))
    if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) {
      return { error: `--at wants viewport coordinates, e.g. --at 320,180 (got "${value}")` }
    }
    params.x = parts[0]
    params.y = parts[1]
  } else {
    params[kind] = value
  }
  if (opts.nth !== undefined && opts.nth !== '') {
    const n = Number(opts.nth)
    if (!Number.isInteger(n) || n < 1)
      return { error: '--nth must be a positive integer (1-based)' }
    params.nth = n
  }
  if (opts.scroll === true) params.scroll = true
  if (tabId) params.tabId = tabId
  return { request: { command: 'click', params } }
}

/** The click target from a command line: `--ref`, `--at`, or the positional —
 * a bare integer (`mira click 12`) is a snapshot ref, `x,y` a point.
 *
 * @param {Record<string, string|boolean>} flags
 * @param {string[]} positionals
 * @returns {{ at: unknown, ref: unknown }}
 */
export function clickPositional(flags, positionals) {
  const p = positionals[0]
  if (flags.at !== undefined || flags.ref !== undefined || p === undefined) {
    return { at: flags.at, ref: flags.ref }
  }
  return /^\d+$/.test(p.trim()) ? { at: undefined, ref: p } : { at: p, ref: undefined }
}

/** A snapshot ref from the command line: a positive integer.
 *
 * @param {unknown} value
 * @returns {number | { error: string }}
 */
function parseRef(value) {
  const n = Number(value)
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim()) || !Number.isInteger(n) || n < 1) {
    return { error: `a ref is a positive integer from \`mira snap\` (got "${value ?? ''}")` }
  }
  return n
}

/**
 * snapshot plan: the page as an indexed table of what it lets you do.
 *
 * @param {string|null} tabId
 * @returns {{ command: string, params: object }}
 */
export function buildSnapshot(tabId) {
  return { command: 'snapshot', params: tabId ? { tabId } : {} }
}

/**
 * type plan: replace the text of the field named by a snapshot ref, or with
 * `focused`, of the element that has focus (no ref, no click): the way into a
 * cross-origin iframe, which a snapshot cannot see. Click the field first.
 *
 * @param {string|null} tabId
 * @param {unknown} ref
 * @param {unknown} text
 * @param {{ focused?: boolean }} [opts]
 * @returns {{ request: {command:string, params:object} } | { error: string }}
 */
export function buildType(tabId, ref, text, opts = {}) {
  if (opts.focused) {
    if (typeof text !== 'string' || text.length === 0) return { error: 'type --focused needs <text>' }
    const params = { focused: true, text }
    if (tabId) params.tabId = tabId
    return { request: { command: 'type-text', params } }
  }
  const n = parseRef(ref)
  if (typeof n !== 'number') return n
  if (typeof text !== 'string' || text.length === 0) return { error: 'type needs <ref> <text>' }
  const params = { ref: n, text }
  if (tabId) params.tabId = tabId
  return { request: { command: 'type-text', params } }
}

/**
 * `mira type` argv → plan: `<ref> <text>`, or `--focused <text>` (no ref).
 *
 * @param {string|null} tabId
 * @param {string[]} positionals
 * @param {Record<string, string|boolean>} flags
 */
export function typePlan(tabId, positionals, flags) {
  if (flags.focused === true) {
    return buildType(tabId, null, positionals.join(' ') || flags.text, { focused: true })
  }
  return buildType(tabId, positionals[0], positionals.slice(1).join(' ') || flags.text)
}

/**
 * select plan: pick a native dropdown option by label (positional or --label)
 * or by value (--value).
 *
 * @param {string|null} tabId
 * @param {unknown} ref
 * @param {{ label?: unknown, value?: unknown }} opts
 * @returns {{ request: {command:string, params:object} } | { error: string }}
 */
export function buildSelect(tabId, ref, opts = {}) {
  const n = parseRef(ref)
  if (typeof n !== 'number') return n
  const label = typeof opts.label === 'string' && opts.label !== '' ? opts.label : null
  const value = typeof opts.value === 'string' ? opts.value : null
  if ((label === null) === (value === null)) {
    return { error: 'select needs <ref> and ONE of <label> / --label / --value' }
  }
  const params = label !== null ? { ref: n, label } : { ref: n, value }
  if (tabId) params.tabId = tabId
  return { request: { command: 'select-option', params } }
}

/**
 * Render a snapshot for a reader (human or agent): one line per element, then
 * the visible text.
 *
 * @param {{ title?: string, url?: string, elements?: any[], text?: string, omitted?: number, scroll?: {y:number,height:number}, viewport?: {w:number,h:number} }} snap
 * @returns {string}
 */
export function formatSnapshot(snap) {
  const lines = [`${snap.title ?? ''} — ${snap.url ?? ''}`]
  for (const el of snap.elements ?? []) {
    let line = `[${el.ref}] ${el.role} ${JSON.stringify(el.label)}`
    if (el.value) line += ` = ${JSON.stringify(el.value)}`
    for (const key of ['checked', 'selected', 'expanded']) {
      if (el[key] !== undefined) line += ` ${key}=${el[key]}`
    }
    const ops = (el.ops ?? []).filter((op) => op !== 'click' || el.ops.length > 1)
    if (ops.length > 0) line += `  (${ops.join(', ')})`
    if (el.options?.length) {
      line += `  options: ${el.options.map((o) => JSON.stringify(o.label)).join(', ')}`
    }
    lines.push(line)
  }
  if (snap.omitted) lines.push(`(${snap.omitted} more elements not listed)`)
  const s = snap.scroll
  const vh = snap.viewport?.h ?? 0
  if (s && s.height > vh) {
    const more = s.y + vh < s.height - 2 ? 'below' : 'above'
    lines.push(`(scrolled ${s.y} of ${s.height}px; more ${more})`)
  }
  if (snap.text) lines.push('', snap.text)
  return lines.join('\n')
}

/**
 * Split one batch line into argv, the way a shell would for the simple cases:
 * whitespace separates, 'single' and "double" quotes group (and keep their
 * contents literal), a backslash escapes the next character outside quotes.
 *
 * Deliberately NOT a shell: no variable expansion, no globbing, no pipes. A
 * batch file is a list of mira commands, not a program — anything that needs a
 * shell belongs in a shell script that calls `mira batch`.
 *
 * @param {string} line
 * @returns {{ argv: string[] } | { error: string }}
 */
export function tokenizeLine(line) {
  const argv = []
  let cur = ''
  let started = false
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = null
      else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      started = true
      continue
    }
    if (c === '\\' && i + 1 < line.length) {
      cur += line[++i]
      started = true
      continue
    }
    if (c === ' ' || c === '\t') {
      if (started) argv.push(cur)
      cur = ''
      started = false
      continue
    }
    cur += c
    started = true
  }
  if (quote) return { error: `unterminated ${quote === '"' ? 'double' : 'single'} quote` }
  if (started) argv.push(cur)
  return { argv }
}

/**
 * Parse a batch script into the lines to run. A line is exactly what would be
 * typed after `mira`; `#` comments and blank lines are dropped. Line numbers are
 * kept (1-based, counted over the ORIGINAL text) so an error names the line the
 * author is looking at.
 *
 * @param {string} text
 * @returns {{ lines: Array<{ lineNo: number, source: string, argv: string[] }> } | { error: string }}
 */
export function parseBatchScript(text) {
  const lines = []
  const raw = String(text ?? '').split('\n')
  for (let i = 0; i < raw.length; i++) {
    const source = raw[i].trim()
    if (source === '' || source.startsWith('#')) continue
    const tok = tokenizeLine(source)
    if ('error' in tok) return { error: `line ${i + 1}: ${tok.error}` }
    if (tok.argv.length === 0) continue
    lines.push({ lineNo: i + 1, source, argv: tok.argv })
  }
  if (lines.length === 0) return { error: 'nothing to run: the batch has no command lines' }
  return { lines }
}

/** Verbs a batch line may NOT use, with the reason. `watch` never returns, `use`
 * only prints an export for the calling shell, and a nested `batch` would hide
 * its own failures inside another one's summary. */
export const BATCH_FORBIDDEN = new Map([
  ['watch', 'watch streams forever; run it on its own'],
  ['use', 'use only prints an export for the calling shell'],
  ['batch', 'a batch cannot nest']
])

/**
 * Turn ONE batch line's argv into the socket request to send. This is the same
 * mapping `bin/mira` does in its switch, minus everything that needs a second
 * round-trip or the terminal — so a batch is exactly N requests on one
 * connection, and every line is validated BEFORE the first one is sent.
 *
 * The batch-level tab target rides in `env.tabId`; a line may override it with
 * its own `--tab`.
 *
 * @param {string[]} argv
 * @param {{ tabId?: string|null, cwd: string, home: string, readFile?: (p:string)=>string }} env
 * @returns {{ request: {command:string, params?:object} } | { error: string }}
 */
export function buildLineRequest(argv, env) {
  const { command, positionals, flags } = parseArgs(argv)
  if (!command) return { error: 'empty line' }
  const forbidden = BATCH_FORBIDDEN.get(command)
  if (forbidden) return { error: `"${command}" is not allowed in a batch: ${forbidden}` }
  const tabId = resolveTabId({ flagTab: flags.tab, envTab: env.tabId })

  switch (command) {
    case 'exec': {
      const arg = positionals[0]
      if (arg === '-') return { error: 'exec - (stdin) makes no sense in a batch; inline the code' }
      const cr = resolveCode(arg, {
        readStdin: () => '',
        readFile:
          env.readFile ??
          (() => {
            throw new Error('no file reader')
          })
      })
      if ('error' in cr) return { error: cr.error }
      return { request: buildExec(cr.code, tabId) }
    }
    case 'press': {
      const modifiers =
        typeof flags.mod === 'string'
          ? flags.mod
              .split(',')
              .map((m) => m.trim())
              .filter(Boolean)
          : []
      return buildPress(positionals[0], tabId, modifiers)
    }
    case 'click':
      return buildClick(tabId, {
        selector: flags.selector,
        text: flags.text,
        ...clickPositional(flags, positionals),
        nth: flags.nth,
        scroll: flags.scroll === true
      })
    case 'snap':
    case 'snapshot':
      return { request: buildSnapshot(tabId) }
    case 'type':
      return typePlan(tabId, positionals, flags)
    case 'select':
      return buildSelect(tabId, positionals[0], {
        label: positionals.slice(1).join(' ') || flags.label,
        value: flags.value
      })
    case 'wait':
    case 'wait-for':
      return buildWait(tabId, {
        selector: flags.selector,
        text: flags.text,
        url: flags.url,
        host: flags.host,
        gone: flags.gone === true,
        timeout: flags.timeout
      })
    case 'reload':
      return { request: buildReload(tabId) }
    case 'shot':
    case 'screenshot':
      return buildScreenshot(positionals[0], tabId, {
        full: flags.full === true,
        cwd: env.cwd,
        home: env.home
      })
    case 'nav':
    case 'navigate':
    case 'open': {
      const url = positionals[0]
      if (!url) return { error: `${command} needs a url` }
      // The interactive CLI resolves a window here (and probes it) so a page
      // never lands in the wrong profile. That is a multi-round-trip dance; in a
      // batch we require a named tab instead of guessing — same protection, no
      // hidden traffic.
      if (!tabId) {
        return {
          error: `${command} in a batch needs a tab target: pass --tab <id> on the line, or set $MIRA_TAB / mira batch --tab <id>`
        }
      }
      return {
        request: buildNav(url, tabId, {
          newTab: command === 'open' || flags['new-tab'] === true,
          background: background(flags)
        })
      }
    }
    case 'tabs': {
      const request = { command: 'list-tabs' }
      if (typeof flags.window === 'string') request.params = { windowId: flags.window }
      return { request }
    }
    case 'windows':
      return { request: { command: 'list-windows' } }
    case 'commands':
      return { request: { command: 'list-commands' } }
    case 'console':
      return {
        request: buildConsole(tabId, { level: flags.level, limit: flags.limit, since: flags.since })
      }
    case 'cookies':
    case 'dump-cookies':
      return {
        request: {
          command: 'dump-cookies',
          params: {
            ...(typeof flags.url === 'string' ? { url: flags.url } : {}),
            ...(tabId ? { tabId } : {})
          }
        }
      }
    case 'call': {
      const name = positionals[0]
      if (!name) return { error: 'call needs a command name' }
      return buildCall(name, flags.params, tabId)
    }
    default:
      return buildCall(command, flags.params, tabId)
  }
}

/**
 * Build every request of a batch up front. Nothing is sent until all the lines
 * parse: half a sequence executed before a typo on line 7 is worse than no
 * sequence at all, because the page is then in a state nobody described.
 *
 * @param {Array<{lineNo:number, source:string, argv:string[]}>} lines
 * @param {{ tabId?: string|null, cwd: string, home: string, readFile?: (p:string)=>string }} env
 * @returns {{ steps: Array<{lineNo:number, source:string, request:object}> } | { error: string }}
 */
export function buildBatch(lines, env) {
  const steps = []
  for (const line of lines) {
    const built = buildLineRequest(line.argv, env)
    if ('error' in built) return { error: `line ${line.lineNo}: ${built.error}  (${line.source})` }
    steps.push({ lineNo: line.lineNo, source: line.source, request: built.request })
  }
  return { steps }
}

/**
 * Render a finished batch: one line per step, then a count. A failed step keeps
 * its error on the same line — reading a batch report must not require opening
 * anything else.
 *
 * @param {Array<{lineNo:number, source:string, response?:object, skipped?:boolean}>} results
 * @returns {string}
 */
export function formatBatchResults(results) {
  const list = results ?? []
  const body = list.map((r, i) => {
    const idx = String(i + 1).padStart(2)
    if (r.skipped) return `${idx}  skip  ${r.source}`
    const ok = r.response && r.response.ok === true
    const detail = ok
      ? ''
      : `  → ${r.response ? (r.response.error ?? JSON.stringify(r.response)) : 'no reply'}`
    return `${idx}  ${ok ? 'ok  ' : 'FAIL'}  ${r.source}${detail}`
  })
  const ran = list.filter((r) => !r.skipped)
  const failed = ran.filter((r) => !(r.response && r.response.ok === true)).length
  const skipped = list.length - ran.length
  const summary =
    `${ran.length - failed} ok, ${failed} failed` + (skipped > 0 ? `, ${skipped} skipped` : '')
  return [...body, summary].join('\n')
}

/**
 * The `client` every socket request must carry (socket.ts rejects one without):
 * the name command.log writes next to each command, so "who pulled Mira in front"
 * has an answer. Built from what identifies the caller, not what it claims to do:
 * `$MIRA_CLIENT` first when set (a script naming itself), then `mira-cli`, the
 * Claude Code session id when there is one, and the working directory.
 *
 * @param {Record<string, string|undefined>} env
 * @param {string} cwd
 * @returns {string}
 */
export function clientName(env, cwd) {
  const parts = []
  const own = (env.MIRA_CLIENT ?? '').trim()
  if (own) parts.push(own)
  parts.push('mira-cli')
  const session = (env.CLAUDE_CODE_SESSION_ID ?? '').trim()
  if (session) parts.push(`session=${session}`)
  if (cwd) parts.push(`cwd=${cwd}`)
  return parts.join(' ')
}

/**
 * Stamp a request with its caller. An explicit `client` already on the request
 * wins, so `mira call` passthroughs keep what they were given.
 *
 * @param {{ command?: string, cmd?: string, params?: object, client?: string }} request
 * @param {string} client
 */
export function withClient(request, client) {
  if (typeof request.client === 'string' && request.client.trim() !== '') return request
  return { client, ...request }
}

/** Max base64 characters per exec-js call: exec times out at ~5 s, and a
 * multi-MB literal is what blew it (see skill, upload recipe). */
export const UPLOAD_CHUNK = 1_500_000

const MIME_BY_EXT = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  heic: 'image/heic',
  gif: 'image/gif',
  webp: 'image/webp',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
}

/** MIME type from a file name; unknown extensions go as octet-stream. */
export function mimeFor(name) {
  const ext = String(name).split('.').pop()?.toLowerCase() ?? ''
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/**
 * Build the exec-js scripts that put local files into a page's
 * `<input type=file>`, so no native picker is ever opened. Returns the scripts
 * in order: one that resets a page-side buffer, one per base64 chunk, and a
 * last one that builds the Files, assigns them through a DataTransfer, fires
 * `input` + `change`, and also calls the element's React `onChange` when the
 * page is a React app (a dispatched event alone is sometimes ignored there).
 * The last script returns `{ files: [names], selector }` or throws if the
 * input is missing.
 *
 * @param {{name:string, b64:string}[]} files
 * @param {{ selector?: string, nth?: number, chunk?: number }} [opts]
 * @returns {{ scripts: string[] } | { error: string }}
 */
export function buildUploadScripts(files, opts = {}) {
  if (!files.length) return { error: 'no file given' }
  const selector = opts.selector || 'input[type=file]'
  const nth = Number.isInteger(opts.nth) && opts.nth > 0 ? opts.nth : 1
  const chunk = opts.chunk || UPLOAD_CHUNK
  const scripts = [`window.__miraUpload = ${JSON.stringify(files.map(() => []))}; true`]
  files.forEach((f, i) => {
    for (let at = 0; at < f.b64.length; at += chunk) {
      scripts.push(`window.__miraUpload[${i}].push(${JSON.stringify(f.b64.slice(at, at + chunk))}); true`)
    }
  })
  const meta = files.map((f) => ({ name: f.name, type: mimeFor(f.name) }))
  scripts.push(`(() => {
  const meta = ${JSON.stringify(meta)};
  const inputs = document.querySelectorAll(${JSON.stringify(selector)});
  const inp = inputs[${nth - 1}];
  if (!inp) throw new Error('no element matches ' + ${JSON.stringify(selector)} + ' (found ' + inputs.length + ')');
  const dt = new DataTransfer();
  meta.forEach((m, i) => {
    const bin = atob(window.__miraUpload[i].join(''));
    const bytes = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
    dt.items.add(new File([bytes], m.name, { type: m.type }));
  });
  delete window.__miraUpload;
  // Read the names BEFORE dispatching: many upload widgets clear the input in their handler.
  const sent = Array.from(dt.files).map((f) => f.name + ' (' + f.size + ' B)');
  inp.files = dt.files;
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  const rk = Object.keys(inp).find((k) => k.startsWith('__reactProps'));
  if (rk && typeof inp[rk].onChange === 'function') {
    inp[rk].onChange({ target: inp, currentTarget: inp, preventDefault() {}, stopPropagation() {}, persist() {} });
  }
  return { files: sent, selector: ${JSON.stringify(selector)} };
})()`)
  return { scripts }
}
