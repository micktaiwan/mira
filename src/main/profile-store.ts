// The profiles data model, kept pure so it is fully unit-tested. A profile has:
//   - a STABLE id  — where its cookies live (partition `persist:mira-<id>`).
//   - a LABEL       — the display name, freely renamable WITHOUT touching the id
//                     (so a rename never disturbs the session / cookies).
// See track.md ("Rename profil = label seul"). Persistence (profiles.json) and
// window creation are native concerns handled elsewhere; this file has no I/O.

export interface Profile {
  id: string
  label: string
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
    const { id, label } = item as { id?: unknown; label?: unknown }
    if (typeof id !== 'string' || id.trim() === '') continue
    if (typeof label !== 'string' || label.trim() === '') continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, label: label.trim() })
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
  return [...profiles, { id: profile.id, label }]
}

/** A default label for a freshly created profile, avoiding collisions with the
 * labels already in use: "Profile 2", "Profile 3", ... */
export function nextProfileLabel(profiles: Profile[]): string {
  const labels = new Set(profiles.map((p) => p.label))
  let n = 2
  while (labels.has(`Profile ${n}`)) n++
  return `Profile ${n}`
}
