// The profiles data model, kept pure so it is fully unit-tested. A profile has:
//   - a STABLE id  — where its cookies live (partition `persist:mira-<id>`).
//   - a LABEL       — the display name, freely renamable WITHOUT touching the id
//                     (so a rename never disturbs the session / cookies).
//   - a COLOR       — an optional theme color (hex) that tints the profile
//                     window's chrome, so windows are tellable apart at a glance.
// See track.md ("Rename profil = label seul"). Persistence (profiles.json) and
// window creation are native concerns handled elsewhere; this file has no I/O.

/** Who created a profile. It decides who may DELETE it: a scripted caller (socket
 * / MCP) may only delete what automation itself created, never a profile the user
 * made by hand — an agent must not be one command away from wiping a real session.
 * The user, in Settings, can delete either. */
export type ProfileOrigin = 'user' | 'automation'

export interface Profile {
  id: string
  label: string
  /** Written only for an automation-created profile, so every pre-existing file
   * (and every profile the user made) reads back as 'user' — the safe default.
   * See ProfileOrigin. */
  origin?: 'automation'
  /** The id of the theme this profile paints its chrome with (see
   * theme-store.ts). Absent falls back to the default theme, or to a legacy
   * `color` if one is still set. */
  themeId?: string
  /** Legacy theme color as a #rrggbb hex — pre-themes profiles. Kept so old
   * profiles keep a distinct tint until re-themed; resolved via
   * resolveProfileTheme. New code sets `themeId`, not this. */
  color?: string
  /** True when this profile is password-protected: its data (partition + trails)
   * lives in an encrypted vault at rest and must be unlocked (mounted + copied out)
   * before its window can open. Absent = a normal, plaintext profile. The vault
   * itself lives outside this model (userData/vaults/<id>.sparsebundle); this flag
   * only records that the profile IS encrypted. See vault.ts. */
  encrypted?: boolean
  /** The absolute folder the profile's embedded terminal (the right-side pane
   * running claude) starts in. Absent = the home folder. See terminal-cwd.ts. */
  terminalCwd?: string
  /** The proxy this profile's session exits the internet through, as Electron
   * proxy rules limited to ONE `<scheme>://host:port` (socks5, http, https; see
   * isProfileProxy). Absent = direct, like every other profile. Never set on the
   * default profile (it runs on Electron's default session). Applied by
   * profile-proxy.ts / the ProfileManager. */
  proxy?: string
  /** Fail-closed marker: profiles.json asked for a proxy Mira cannot honor (a
   * malformed value, or any proxy on the default profile). Holds the raw value
   * as text. While set, the profile loads NO web page (profile-proxy.ts gate),
   * and a non-default profile's session is also black-holed (the default
   * profile's session is Electron's default one, never reconfigured: the gate
   * alone blocks it), until set-profile-proxy sets a valid proxy or clears it.
   * Never both `proxy` and `proxyInvalid`. */
  proxyInvalid?: string
}

/** The preset theme colors offered in Settings. Any valid hex is accepted by
 * the model (setProfileColor) — this list is only the curated picker palette.
 * Must match PROFILE_COLORS in src/renderer/src/Settings.tsx. */
export const PROFILE_COLORS = [
  '#4d7cfe', // blue
  '#8b5cf6', // purple
  '#ec4899', // pink
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#14b8a6' // teal
] as const

/** Valid theme color: a #rgb or #rrggbb hex. Kept permissive on purpose — the
 * picker offers presets, but the command accepts any hex (socket / MCP). */
export function isProfileColor(value: unknown): value is string {
  return typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)
}

/** The proxy schemes a profile may use. Chromium also knows `direct://` and
 * `quic://`, and accepts lists with a DIRECT fallback: none of that is allowed
 * here, so a dead proxy can never silently fall back to the home connection.
 * socks4 is refused too: Chromium resolves the hostname LOCALLY for it (SOCKS4,
 * not 4a), so every DNS lookup would leak to the home resolver (measured:
 * scripts/proxy-probe). */
export const PROFILE_PROXY_SCHEMES = ['socks5', 'http', 'https'] as const

// A DNS name (RFC 1123 labels), an IPv4 literal (matched by the same pattern), or
// a bracketed IPv6 literal. No userinfo, no path, no query: one host and a port.
const PROXY_RE =
  /^(socks5|http|https):\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*):([1-9][0-9]{0,4})$/

/** Valid profile proxy: exactly `<socks5|http|https>://<host>:<port>`,
 * lowercase scheme, explicit port 1-65535. Strict on purpose: the value goes
 * straight into Chromium's proxyRules, where a list, a `DIRECT` entry or a
 * per-scheme rule would change what happens when the proxy is down. */
export function isProfileProxy(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const m = PROXY_RE.exec(value)
  if (!m) return false
  return Number(m[3]) <= 65535
}

export const DEFAULT_PROFILE_ID = 'default'
const DEFAULT_PROFILE_LABEL = 'Default'

/** Session partition for a profile. The default profile uses Electron's default
 * session (undefined) so existing cookies are kept; every other profile gets an
 * isolated persistent partition keyed by its STABLE id. */
export function partitionForId(id: string): string | undefined {
  return id === DEFAULT_PROFILE_ID ? undefined : `persist:mira-${id}`
}

export function defaultProfiles(): Profile[] {
  return [{ id: DEFAULT_PROFILE_ID, label: DEFAULT_PROFILE_LABEL }]
}

/** Coerce whatever was parsed from profiles.json into a valid list: keep only
 * well-formed {id,label} entries, drop duplicate ids, and guarantee the default
 * profile exists and comes first. Never throws — bad input degrades to sane
 * defaults. */
export function normalizeProfiles(raw: unknown): Profile[] {
  const out: Profile[] = []
  const seen = new Set<string>()
  const list = Array.isArray(raw) ? raw : []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const { id, label, themeId, color, encrypted, origin, terminalCwd, proxy, proxyInvalid } =
      item as {
      id?: unknown
      label?: unknown
      themeId?: unknown
      color?: unknown
      encrypted?: unknown
      origin?: unknown
      terminalCwd?: unknown
      proxy?: unknown
      proxyInvalid?: unknown
    }
    if (typeof id !== 'string' || id.trim() === '') continue
    if (typeof label !== 'string' || label.trim() === '') continue
    if (seen.has(id)) continue
    seen.add(id)
    // A malformed persisted color/themeId degrades to "unset", never throws.
    out.push({
      id,
      label: label.trim(),
      ...(typeof themeId === 'string' && themeId.trim() !== '' ? { themeId: themeId.trim() } : {}),
      ...(isProfileColor(color) ? { color } : {}),
      ...(encrypted === true ? { encrypted: true } : {}),
      ...(origin === 'automation' ? { origin: 'automation' as const } : {}),
      ...(typeof terminalCwd === 'string' && terminalCwd.startsWith('/') ? { terminalCwd } : {}),
      ...readProxyFields(id, proxy, proxyInvalid)
    })
  }
  const def = out.find((p) => p.id === DEFAULT_PROFILE_ID) ?? {
    id: DEFAULT_PROFILE_ID,
    label: DEFAULT_PROFILE_LABEL
  }
  return [def, ...out.filter((p) => p.id !== DEFAULT_PROFILE_ID)]
}

/** The proxy fields of one persisted profile, failing CLOSED: a proxy Mira cannot
 * honor (malformed, or on the default profile) becomes the proxyInvalid marker,
 * never a silent "no proxy" — the profile was meant to leave through a proxy, so
 * it must not quietly go out direct. Absent / null / '' = no proxy. */
function readProxyFields(
  id: string,
  proxy: unknown,
  proxyInvalid: unknown
): { proxy?: string; proxyInvalid?: string } {
  if (proxy !== undefined && proxy !== null && proxy !== '') {
    if (id !== DEFAULT_PROFILE_ID && isProfileProxy(proxy)) return { proxy }
    const raw = typeof proxy === 'string' ? proxy : JSON.stringify(proxy)
    return { proxyInvalid: raw.slice(0, 200) }
  }
  if (typeof proxyInvalid === 'string' && proxyInvalid !== '') {
    return { proxyInvalid: proxyInvalid.slice(0, 200) }
  }
  return {}
}

export function findById(profiles: Profile[], id: string): Profile | undefined {
  return profiles.find((p) => p.id === id)
}

/** Return a new list with profile `id` relabelled. Throws on unknown id or empty
 * label. The id is never touched, so cookies are preserved. */
export function renameProfile(profiles: Profile[], id: string, label: string): Profile[] {
  const trimmed = label.trim()
  if (trimmed === '') throw new Error('empty label')
  if (!findById(profiles, id)) throw new Error(`unknown profile: ${id}`)
  return profiles.map((p) => (p.id === id ? { ...p, label: trimmed } : p))
}

/** Who created this profile — absent in the file means the user (see ProfileOrigin). */
export function profileOrigin(profile: Profile): ProfileOrigin {
  return profile.origin === 'automation' ? 'automation' : 'user'
}

/** Append a new profile. Throws on empty id/label or a duplicate id. */
export function addProfile(profiles: Profile[], profile: Profile): Profile[] {
  const label = profile.label.trim()
  if (profile.id.trim() === '') throw new Error('empty id')
  if (label === '') throw new Error('empty label')
  if (findById(profiles, profile.id)) throw new Error(`duplicate profile: ${profile.id}`)
  return [
    ...profiles,
    {
      id: profile.id,
      label,
      ...(profile.color ? { color: profile.color } : {}),
      ...(profile.origin === 'automation' ? { origin: 'automation' as const } : {})
    }
  ]
}

/** Everything that decides whether profile `id` may be deleted, in one pure place
 * so both the model and the ProfileManager (which must check BEFORE it wipes any
 * file) ask the same question. Returns the profile, or throws:
 *   - the DEFAULT profile is never deletable: it owns Electron's default session
 *     (partitionForId returns undefined for it), so there is no self-contained dir
 *     to remove, and normalizeProfiles would recreate it on the next read anyway.
 *   - an unknown id is an error, not a no-op.
 *   - `requester` 'automation' (a socket / MCP / agent call) may only delete what
 *     automation itself created. A profile the user made by hand holds real
 *     cookies and logins; no script gets to wipe it — the user does, from Settings.
 */
export function assertProfileDeletable(
  profiles: Profile[],
  id: string,
  requester: ProfileOrigin = 'user'
): Profile {
  if (id === DEFAULT_PROFILE_ID) throw new Error('the default profile cannot be deleted')
  const profile = findById(profiles, id)
  if (!profile) throw new Error(`unknown profile: ${id}`)
  if (requester === 'automation' && profileOrigin(profile) !== 'automation') {
    throw new Error(`profile ${id} was not created by automation: delete it from Settings`)
  }
  return profile
}

/** Return a new list without profile `id`. Throws per assertProfileDeletable. */
export function removeProfile(
  profiles: Profile[],
  id: string,
  requester: ProfileOrigin = 'user'
): Profile[] {
  assertProfileDeletable(profiles, id, requester)
  return profiles.filter((p) => p.id !== id)
}

/** Return a new list with profile `id`'s theme color set (a #rgb/#rrggbb hex)
 * or cleared (null). The id and label are untouched. Throws on unknown id or a
 * malformed color. */
export function setProfileColor(profiles: Profile[], id: string, color: string | null): Profile[] {
  if (!findById(profiles, id)) throw new Error(`unknown profile: ${id}`)
  if (color !== null && !isProfileColor(color)) throw new Error(`invalid color: ${color}`)
  return profiles.map((p) => {
    if (p.id !== id) return p
    const { color: _dropped, ...rest } = p
    return color === null ? rest : { ...rest, color }
  })
}

/** Return a new list with profile `id`'s theme set to `themeId` (or cleared
 * with null, falling back to the default theme). Setting a theme drops any
 * legacy `color`, so the two never fight. Throws on unknown id. */
export function setProfileTheme(
  profiles: Profile[],
  id: string,
  themeId: string | null
): Profile[] {
  if (!findById(profiles, id)) throw new Error(`unknown profile: ${id}`)
  const trimmed = themeId?.trim() || null
  return profiles.map((p) => {
    if (p.id !== id) return p
    const { themeId: _t, color: _c, ...rest } = p
    return trimmed ? { ...rest, themeId: trimmed } : rest
  })
}

/** Return a new list with profile `id`'s terminal folder set to `cwd` (already
 * normalized: see normalizeTerminalCwd) or cleared with null (back to the home
 * folder). Throws on unknown id or a relative folder. */
export function setProfileTerminalCwd(
  profiles: Profile[],
  id: string,
  cwd: string | null
): Profile[] {
  if (!findById(profiles, id)) throw new Error(`unknown profile: ${id}`)
  if (cwd !== null && !cwd.startsWith('/')) throw new Error(`not an absolute folder: ${cwd}`)
  return profiles.map((p) => {
    if (p.id !== id) return p
    const { terminalCwd: _c, ...rest } = p
    return cwd === null ? rest : { ...rest, terminalCwd: cwd }
  })
}

/** Return a new list with profile `id`'s proxy set (a value isProfileProxy
 * accepts) or cleared with null (back to a direct connection). Throws on unknown
 * id, on the default profile (its session is Electron's default one, which Mira
 * never reconfigures), or on a malformed proxy. */
export function setProfileProxy(profiles: Profile[], id: string, proxy: string | null): Profile[] {
  if (!findById(profiles, id)) throw new Error(`unknown profile: ${id}`)
  if (id === DEFAULT_PROFILE_ID && proxy !== null) {
    throw new Error('the default profile cannot use a proxy: create a separate profile for it')
  }
  if (proxy !== null && !isProfileProxy(proxy)) throw new Error(`invalid proxy: ${proxy}`)
  return profiles.map((p) => {
    if (p.id !== id) return p
    // A valid value or a clear also lifts the fail-closed marker.
    const { proxy: _p, proxyInvalid: _i, ...rest } = p
    return proxy === null ? rest : { ...rest, proxy }
  })
}

/** A default label for a freshly created profile, avoiding collisions with the
 * labels already in use: "Profile 2", "Profile 3", ... */
export function nextProfileLabel(profiles: Profile[]): string {
  const labels = new Set(profiles.map((p) => p.label))
  let n = 2
  while (labels.has(`Profile ${n}`)) n++
  return `Profile ${n}`
}

/** Which profile to open at cold launch, if the caller forced one — from a
 * `--profile <id>` / `--profile=<id>` CLI flag, or the `MIRA_PROFILE` env var
 * (the flag wins). Returns the id, or null to fall back to the normal startup
 * (reopen the last-open set). Purely a parse: it does NOT check the id exists —
 * the manager validates and falls back on an unknown id. Kept here (pure) so the
 * "launch a specific profile" feature is unit-tested without booting Electron. */
export function parseProfileArg(argv: readonly string[], env: NodeJS.ProcessEnv): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--profile') {
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) return next.trim() || null
    } else if (arg.startsWith('--profile=')) {
      return arg.slice('--profile='.length).trim() || null
    }
  }
  const fromEnv = env.MIRA_PROFILE?.trim()
  return fromEnv ? fromEnv : null
}
