// The profiles data model, kept pure so it is fully unit-tested. A profile has:
//   - a STABLE id  — where its cookies live (partition `persist:mira-<id>`).
//   - a LABEL       — the display name, freely renamable WITHOUT touching the id
//                     (so a rename never disturbs the session / cookies).
//   - a COLOR       — an optional theme color (hex) that tints the profile
//                     window's chrome, so windows are tellable apart at a glance.
// See track.md ("Rename profil = label seul"). Persistence (profiles.json) and
// window creation are native concerns handled elsewhere; this file has no I/O.

export interface Profile {
  id: string
  label: string
  /** Theme color as a #rrggbb hex, or absent for the neutral chrome. */
  color?: string
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
    const { id, label, color } = item as { id?: unknown; label?: unknown; color?: unknown }
    if (typeof id !== 'string' || id.trim() === '') continue
    if (typeof label !== 'string' || label.trim() === '') continue
    if (seen.has(id)) continue
    seen.add(id)
    // A malformed persisted color degrades to "no color", never throws.
    out.push({ id, label: label.trim(), ...(isProfileColor(color) ? { color } : {}) })
  }
  const def = out.find((p) => p.id === DEFAULT_PROFILE_ID) ?? {
    id: DEFAULT_PROFILE_ID,
    label: DEFAULT_PROFILE_LABEL
  }
  return [def, ...out.filter((p) => p.id !== DEFAULT_PROFILE_ID)]
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

/** Append a new profile. Throws on empty id/label or a duplicate id. */
export function addProfile(profiles: Profile[], profile: Profile): Profile[] {
  const label = profile.label.trim()
  if (profile.id.trim() === '') throw new Error('empty id')
  if (label === '') throw new Error('empty label')
  if (findById(profiles, profile.id)) throw new Error(`duplicate profile: ${profile.id}`)
  return [
    ...profiles,
    { id: profile.id, label, ...(profile.color ? { color: profile.color } : {}) }
  ]
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

/** A default label for a freshly created profile, avoiding collisions with the
 * labels already in use: "Profile 2", "Profile 3", ... */
export function nextProfileLabel(profiles: Profile[]): string {
  const labels = new Set(profiles.map((p) => p.label))
  let n = 2
  while (labels.has(`Profile ${n}`)) n++
  return `Profile ${n}`
}
