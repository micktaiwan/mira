// Pure model of the sideloaded-extensions registry: which unpacked extension
// directories each profile has loaded, persisted to userData/extensions.json so
// they reload at every boot (Electron forgets loaded extensions on quit — see
// extensions-plan.md §2). No Electron here, per the "tout testable" principle.
//
// Web Store installs (E5) will live under userData/Extensions/<profileId>/ and
// be discovered by scanning that directory; THIS registry only records
// sideloads (`load-extension {path}`), whose directories live wherever the
// user keeps them.

/** Sideloaded unpacked extension directories, keyed by profile id. */
export type SideloadedExtensions = Record<string, string[]>

/** A paused extension as remembered by the disabled registry: enough to show it
 * in Settings while unloaded (id/name/version) and to reload it on resume
 * (path). Structurally the commands' ExtensionInfo, redeclared here so the
 * store stays a pure standalone model. */
export interface DisabledExtension {
  id: string
  name: string
  version: string
  path: string
}

/** Paused (unloaded but not uninstalled) extensions, keyed by profile id.
 * Persisted so a pause survives restarts: at boot the loaders load everything,
 * then ExtensionsService unloads whatever this registry lists. */
export type DisabledExtensions = Record<string, DisabledExtension[]>

/** Parse whatever was in extensions.json into a valid registry. Anything
 * malformed (bad root, non-array value, non-string entry) is dropped — a broken
 * file must degrade to "no extensions", never break boot. */
export function normalizeSideloaded(raw: unknown): SideloadedExtensions {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const result: SideloadedExtensions = {}
  for (const [profileId, paths] of Object.entries(raw)) {
    if (!Array.isArray(paths)) continue
    const valid = paths.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    if (valid.length > 0) result[profileId] = valid
  }
  return result
}

/** The sideloaded paths recorded for one profile (empty when none). */
export function sideloadedFor(map: SideloadedExtensions, profileId: string): string[] {
  return map[profileId] ?? []
}

/** Record a sideloaded path for a profile. Idempotent by path — re-loading the
 * same directory doesn't duplicate the entry. Returns a new map. */
export function addSideloaded(
  map: SideloadedExtensions,
  profileId: string,
  path: string
): SideloadedExtensions {
  const existing = map[profileId] ?? []
  if (existing.includes(path)) return map
  return { ...map, [profileId]: [...existing, path] }
}

/** Parse whatever was in the disabled-extensions file into a valid registry.
 * Same degradation contract as normalizeSideloaded: malformed entries are
 * dropped, a broken file means "nothing disabled", never a broken boot. */
export function normalizeDisabled(raw: unknown): DisabledExtensions {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const result: DisabledExtensions = {}
  for (const [profileId, entries] of Object.entries(raw)) {
    if (!Array.isArray(entries)) continue
    const valid = entries.filter(
      (e): e is DisabledExtension =>
        typeof e === 'object' &&
        e !== null &&
        typeof e.id === 'string' &&
        e.id.trim() !== '' &&
        typeof e.name === 'string' &&
        typeof e.version === 'string' &&
        typeof e.path === 'string' &&
        e.path.trim() !== ''
    )
    if (valid.length > 0) result[profileId] = valid
  }
  return result
}

/** The disabled extensions recorded for one profile (empty when none). */
export function disabledFor(map: DisabledExtensions, profileId: string): DisabledExtension[] {
  return map[profileId] ?? []
}

/** Record an extension as disabled for a profile. Recording an id already
 * present replaces its entry (so a refreshed path/version wins). Returns a new
 * map. */
export function addDisabled(
  map: DisabledExtensions,
  profileId: string,
  ext: DisabledExtension
): DisabledExtensions {
  const existing = map[profileId] ?? []
  return { ...map, [profileId]: [...existing.filter((e) => e.id !== ext.id), ext] }
}

/** Forget a disabled extension for a profile (re-enable or uninstall). Removing
 * the last entry drops the profile's key entirely. Returns a new map. */
export function removeDisabled(
  map: DisabledExtensions,
  profileId: string,
  id: string
): DisabledExtensions {
  const existing = map[profileId]
  if (!existing || !existing.some((e) => e.id === id)) return map
  const remaining = existing.filter((e) => e.id !== id)
  const next = { ...map }
  if (remaining.length === 0) delete next[profileId]
  else next[profileId] = remaining
  return next
}

/** Forget a sideloaded path for a profile (uninstall). Removing the last path
 * drops the profile's key entirely. Returns a new map. */
export function removeSideloaded(
  map: SideloadedExtensions,
  profileId: string,
  path: string
): SideloadedExtensions {
  const existing = map[profileId]
  if (!existing || !existing.includes(path)) return map
  const remaining = existing.filter((p) => p !== path)
  const next = { ...map }
  if (remaining.length === 0) delete next[profileId]
  else next[profileId] = remaining
  return next
}
