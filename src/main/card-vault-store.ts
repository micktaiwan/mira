// Which Bitwarden account each Mira profile saves cards to — the data model,
// pure and unit-tested (the JSON file I/O is the thin edge in
// bitwarden-service.ts).
//
// THE WHOLE POINT of this map is the wall between accounts. A profile with no
// entry here NEVER offers to save a card, and never touches a vault. That is how
// "cards live in the perso account and the pro account never sees one" is
// enforced: not by a checkbox in a dialog, but by the absence of a mapping. The
// pro profile is unmapped, so the code path that writes to bw cannot even start.
//
// A vault is addressed by its BITWARDENCLI_APPDATA_DIR — see bitwarden.ts for
// why that directory, not an email, is the unit of account.

import { isAbsolute, join } from 'path'
import type { CardVault } from './bitwarden'

/** profileId → the vault that profile saves cards to. */
export type CardVaultMap = Record<string, CardVault>

/** Turn `~/x` into an absolute path under `home`. Left alone if already
 * absolute. Pure — the home dir is injected. */
export function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  return path
}

/** Whether a value can be used as a vault appdata dir: a non-empty ABSOLUTE
 * path. Relative paths are refused because bw would resolve them against Mira's
 * cwd, which is not something a user can reason about. Pure. */
export function isValidVaultDir(value: unknown, home: string): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false
  return isAbsolute(expandHome(value.trim(), home))
}

/** Read card-vaults.json content into a map, dropping every malformed entry
 * rather than throwing — a corrupted file must not stop Mira from starting, it
 * must only mean "no card saving until it is fixed". Pure. */
export function parseVaultMap(raw: unknown, home: string): CardVaultMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: CardVaultMap = {}
  for (const [profileId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!profileId.trim()) continue
    const v = (value ?? {}) as { appDataDir?: unknown; email?: unknown }
    if (!isValidVaultDir(v.appDataDir, home)) continue
    out[profileId] = {
      appDataDir: expandHome((v.appDataDir as string).trim(), home),
      ...(typeof v.email === 'string' && v.email ? { email: v.email } : {})
    }
  }
  return out
}

/** The vault a profile writes to, or null when the profile is unmapped (the
 * default for every profile, including pro ones). Pure. */
export function vaultFor(map: CardVaultMap, profileId: string): CardVault | null {
  return map[profileId] ?? null
}

/** Map a profile to a vault, returning a NEW map. Throws on an invalid dir so a
 * bad `set-card-vault` call fails loudly instead of silently disabling saving.
 * Pure. */
export function setVault(
  map: CardVaultMap,
  profileId: string,
  vault: { appDataDir: string; email?: string },
  home: string
): CardVaultMap {
  if (!profileId.trim()) throw new Error('missing profile id')
  if (!isValidVaultDir(vault.appDataDir, home)) {
    throw new Error('"appDataDir" must be an absolute path')
  }
  return {
    ...map,
    [profileId]: {
      appDataDir: expandHome(vault.appDataDir.trim(), home),
      ...(vault.email ? { email: vault.email } : {})
    }
  }
}

/** Unmap a profile (it stops offering to save cards), returning a NEW map. Pure. */
export function removeVault(map: CardVaultMap, profileId: string): CardVaultMap {
  if (!(profileId in map)) return map
  const next = { ...map }
  delete next[profileId]
  return next
}

/** Remember the email `bw status` reported, so Settings can show WHICH account a
 * profile writes to without unlocking anything. Returns a NEW map; unknown
 * profiles are left untouched. Pure. */
export function rememberEmail(map: CardVaultMap, profileId: string, email: string): CardVaultMap {
  const current = map[profileId]
  if (!current || !email || current.email === email) return map
  return { ...map, [profileId]: { ...current, email } }
}
