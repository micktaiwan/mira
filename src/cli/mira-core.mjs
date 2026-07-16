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
export const BOOLEAN_FLAGS = new Set(['json', 'active', 'help'])

/** Registry commands that accept a `tabId` param (see docs/socket.md). Only for
 * these does a resolved tab target get injected into params — injecting `tabId`
 * into e.g. select-tab (which wants `id`) would be wrong. */
export const TAB_BOUND = new Set(['exec-js', 'collect-media', 'download-media', 'press-key'])

/**
 * Parse an argv tail (already stripped of node + script path) into a command,
 * its positional args, and its flags.
 *
 * @param {string[]} argv
 * @returns {{ command: string|null, positionals: string[], flags: Record<string, string|boolean> }}
 */
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
 * Reload plan. The socket `reload` command is active-tab-only (no tabId param),
 * so to reload a *pinned* tab we go through exec-js — exactly the manual dance
 * this CLI exists to remove.
 *
 * @param {string|null} tabId
 * @returns {{ command: string, params?: object }}
 */
export function buildReload(tabId) {
  if (tabId) return buildExec("location.reload(); 'ok'", tabId)
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
 *
 * @param {Array<{id:string,url?:string,title?:string,loaded?:boolean}>} tabs
 * @param {string} [activeId]
 * @returns {string}
 */
export function formatTabs(tabs, activeId) {
  return (tabs ?? [])
    .map((t) => {
      const mark = t.id === activeId ? '*' : t.loaded === false ? 'z' : ' '
      const title = (t.title ?? '').slice(0, 40).padEnd(40)
      return `${mark} ${t.id}  ${title}  ${t.url ?? ''}`
    })
    .join('\n')
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
