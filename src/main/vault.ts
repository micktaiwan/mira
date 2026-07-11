// Pure logic for the password-protected (encrypted) profile. The MODEL: a profile
// marked `encrypted` keeps its data — its browsing trails (userData/profiles/<id>/)
// AND its Electron session partition (userData/Partitions/mira-<id>/) — inside an
// AES-256 encrypted sparsebundle at rest. Unlocking mounts it and COPIES the data
// back to those normal userData locations (no symlink — Mira reads them as usual);
// locking copies the live data back into the vault and wipes the plaintext. This is
// the same "encrypt a folder" flow as Files' VaultService, applied to two dirs.
//
// This file is pure path/state arithmetic (unit-tested). The hdiutil / copy / wipe
// I/O is the thin native edge in vault-service.ts; the window lifecycle wiring is in
// profiles.ts.

import { join } from 'path'
import { DEFAULT_PROFILE_ID, partitionForId } from './profile-store'

/** One directory that makes up a profile's data: where Mira reads it while unlocked
 * (`live`, an absolute userData path) and its name inside the mounted vault. */
export interface VaultDir {
  live: string
  name: string
}

/** Everything the native edge needs to lock/unlock a profile: the encrypted image
 * path, its mounted volume name, and the live dirs it protects. */
export interface VaultPlan {
  /** The encrypted disk image (userData/vaults/<id>.sparsebundle). */
  bundle: string
  /** The APFS volume name when the image is mounted. */
  volumeName: string
  /** The profile's data dirs — its trails and its session partition — stashed in /
   * restored from the vault. */
  dirs: VaultDir[]
}

/** Only a NON-default profile can be encrypted. The default profile's cookies live
 * directly in userData (it uses Electron's default session, with no partition dir),
 * so it has no self-contained directory to move into a vault. Throws otherwise. */
export function assertEncryptable(profileId: string): void {
  if (profileId === DEFAULT_PROFILE_ID) {
    throw new Error('the default profile cannot be encrypted')
  }
  if (profileId.trim() === '') throw new Error('missing profile id')
}

/** The on-disk folder name of a profile's Electron partition, under
 * userData/Partitions/. partitionForId yields the `persist:mira-<id>` partition
 * STRING; Chromium drops the `persist:` scheme for the directory name. This is the
 * CANONICAL name (used at encrypt time); unlocked sessions use a per-unlock nonce
 * variant — see noncePartitionDir. */
export function partitionDirName(profileId: string): string {
  const partition = partitionForId(profileId)
  // Non-default always has a partition; the fallback keeps this total for tests.
  return partition ? partition.replace(/^persist:/, '') : `mira-${profileId}`
}

/** The on-disk partition folder name for ONE unlock session: the canonical name
 * plus a random nonce. WHY: Electron caches a partition's Session object (cookies,
 * storage) in memory for the whole app run and never reloads it when the files are
 * swapped underneath. If unlock restored the vault into the canonical `mira-<id>`
 * dir and reused `persist:mira-<id>`, a second unlock in the same run would get the
 * STALE cached session (logged out) — the exact cookie-loss bug. A fresh, never-seen
 * partition name per unlock forces Electron to build a new session that reads the
 * just-restored files. The dir is disposable: it is wiped at lock and reconcile. */
export function noncePartitionDir(profileId: string, nonce: string): string {
  return `${partitionDirName(profileId)}-${nonce}`
}

/** Whether an entry under userData/Partitions/ belongs to `profileId` — its
 * canonical dir OR any per-unlock nonce dir (canonical + `-<nonce>`). Used by
 * reconcile to wipe every leftover plaintext partition of an encrypted profile at
 * startup, including nonce dirs orphaned by a crash (nonces live only in RAM, so
 * after a restart the dir name is the only trace). Pure so it is unit-tested. */
export function isProfilePartitionDir(dirName: string, profileId: string): boolean {
  const canonical = partitionDirName(profileId)
  return dirName === canonical || dirName.startsWith(`${canonical}-`)
}

/** The vault plan for a profile: where its encrypted image lives and which live
 * directories it protects (browsing trails + session partition). Pure.
 *
 * `partitionDir` overrides the on-disk partition folder name. Omitted → the
 * CANONICAL name (used at encrypt, where the pre-encryption data sits). Unlock/lock
 * pass a per-unlock nonce dir (see noncePartitionDir) so Electron gets a fresh
 * session that actually reads the restored cookies. The name INSIDE the vault stays
 * 'partition' regardless, so the vault layout is stable across unlocks. */
export function vaultPlan(
  userDataDir: string,
  profileId: string,
  partitionDir?: string
): VaultPlan {
  assertEncryptable(profileId)
  return {
    bundle: join(userDataDir, 'vaults', `${profileId}.sparsebundle`),
    volumeName: `mira-${profileId}`,
    dirs: [
      { live: join(userDataDir, 'profiles', profileId), name: 'profiles' },
      {
        live: join(userDataDir, 'Partitions', partitionDir ?? partitionDirName(profileId)),
        name: 'partition'
      }
    ]
  }
}

/** A password must be non-empty (hdiutil accepts any bytes, but an empty password
 * is almost certainly a mistake and yields an un-protected vault). */
export function isValidVaultPassword(password: unknown): password is string {
  return typeof password === 'string' && password.length > 0
}

/** Whether a profile must be unlocked before its window can open: it is encrypted
 * and not yet unlocked THIS session (unlockedIds tracks the runtime state — a vault
 * currently mounted-out to its live locations). A plaintext profile never needs it. */
export function needsUnlock(
  profile: { id: string; encrypted?: boolean },
  unlockedIds: ReadonlySet<string>
): boolean {
  return profile.encrypted === true && !unlockedIds.has(profile.id)
}
