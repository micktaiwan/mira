// The NATIVE edge of the encrypted profile: AES-256 sparsebundle management via
// /usr/bin/hdiutil plus directory copy/wipe, ported from Files' VaultService.swift.
// Not unit-tested (real disk + subprocess); the pure plan/paths/state logic it acts
// on is in vault.ts (tested).
//
// Safety: encrypt() and lock() WIPE the plaintext after copying it into the vault,
// so both VERIFY the copy (file inventory: every source file present at the same
// size) BEFORE deleting anything. A failed copy leaves the plaintext untouched.

import { spawn } from 'child_process'
import { cpSync, rmSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs'
import { join, dirname, relative } from 'path'
import { isProfilePartitionDir, type VaultPlan } from './vault'

/** Sparse cap: the image is hollow and only consumes real disk for what is stored,
 * so this is a ceiling, not a reservation (same as Files' VaultService). */
const DEFAULT_CAP_GB = 100

/** Run hdiutil, feeding `password` on stdin (raw bytes, no newline) when given.
 * Resolves stdout on exit 0, rejects with the trimmed stderr otherwise. */
function runHdiutil(args: string[], password?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/hdiutil', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += String(d)))
    child.stderr.on('data', (d) => (err += String(d)))
    child.on('error', (e) => reject(new Error(`hdiutil not runnable: ${e.message}`)))
    child.on('close', (code) => {
      if (code === 0) resolve(out)
      else {
        const msg = err.trim() || `hdiutil exited with code ${code}`
        const authFailure = /authentication error/i.test(msg)
        reject(new Error(authFailure ? 'wrong password' : msg))
      }
    })
    if (password !== undefined) child.stdin.write(password)
    child.stdin.end()
  })
}

/** Attach (mount) a sparsebundle and return its mount point. `-nobrowse` keeps the
 * volume out of Finder so Mira stays in control. */
async function mount(bundle: string, password: string): Promise<string> {
  const out = await runHdiutil(['attach', '-stdinpass', '-nobrowse', bundle], password)
  // hdiutil prints tab-separated rows; the mount point is the /Volumes/... path.
  const idx = out.indexOf('/Volumes/')
  if (idx === -1) throw new Error('mounted, but could not read the mount point')
  return out.slice(idx).split('\n')[0].trim()
}

/** Detach (unmount) by mount point. `force` tears it down even with open files. */
async function unmount(mountPoint: string, force = false): Promise<void> {
  await runHdiutil(['detach', ...(force ? ['-force'] : []), mountPoint])
}

/** Every regular file under `root`, keyed by path relative to `root`, valued by
 * byte size. Used to confirm a copy is intact before wiping the source. */
function fileInventory(root: string): Map<string, number> {
  const map = new Map<string, number>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) map.set(relative(root, full), statSync(full).size)
    }
  }
  if (existsSync(root)) walk(root)
  return map
}

/** True when every file under `src` exists under `dest` with the same size. Extra
 * files in `dest` (macOS volume metadata like .Spotlight-V100) are ignored. */
function verifyCopy(src: string, dest: string): boolean {
  const want = fileInventory(src)
  const have = fileInventory(dest)
  for (const [rel, size] of want) {
    if (have.get(rel) !== size) return false
  }
  return true
}

/** Copy `src` into `dest` (recursive), replacing whatever is at `dest`. */
function replaceDir(src: string, dest: string): void {
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dirname(dest), { recursive: true })
  if (existsSync(src)) cpSync(src, dest, { recursive: true })
}

/** Turn a profile's plaintext data into an encrypted vault (one-time): create the
 * sparsebundle, copy each live dir in, VERIFY, then wipe the plaintext. On any
 * failure before verification the plaintext is left untouched and the partial vault
 * is removed. */
export async function encrypt(plan: VaultPlan, password: string): Promise<void> {
  if (existsSync(plan.bundle)) throw new Error(`a vault already exists: ${plan.bundle}`)
  mkdirSync(dirname(plan.bundle), { recursive: true })
  await runHdiutil(
    [
      'create',
      '-encryption',
      'AES-256',
      '-stdinpass',
      '-type',
      'SPARSEBUNDLE',
      '-fs',
      'APFS',
      '-volname',
      plan.volumeName,
      '-size',
      `${DEFAULT_CAP_GB}g`,
      plan.bundle
    ],
    password
  )
  let mountPoint: string | null = null
  try {
    mountPoint = await mount(plan.bundle, password)
    for (const dir of plan.dirs) {
      if (existsSync(dir.live)) cpSync(dir.live, join(mountPoint, dir.name), { recursive: true })
    }
    // Verify every dir copied intact BEFORE wiping any plaintext.
    for (const dir of plan.dirs) {
      if (existsSync(dir.live) && !verifyCopy(dir.live, join(mountPoint, dir.name))) {
        throw new Error(`vault copy of ${dir.name} could not be verified`)
      }
    }
    await unmount(mountPoint)
    mountPoint = null
    // Copy verified — now wipe the plaintext (direct unlink, never the Trash).
    for (const dir of plan.dirs) rmSync(dir.live, { recursive: true, force: true })
  } catch (error) {
    // Roll back everything BUT the source: unmount and drop the partial vault.
    if (mountPoint) await unmount(mountPoint, true).catch(() => {})
    rmSync(plan.bundle, { recursive: true, force: true })
    throw error
  }
}

/** Wipe a profile's live plaintext dirs WITHOUT touching the vault. Used at startup
 * to discard a stale unlocked session left by an unclean shutdown (crash / quit
 * while unlocked): the vault, last cleanly locked, stays the source of truth.
 * Losing that unclean session is acceptable — it is "incognito that kept cookies". */
export function discardPlaintext(plan: VaultPlan): void {
  for (const dir of plan.dirs) rmSync(dir.live, { recursive: true, force: true })
}

/** Wipe ALL leftover plaintext of an encrypted profile: its browsing-trails dir and
 * EVERY partition dir belonging to it — the canonical one AND any per-unlock nonce
 * dir (`mira-<id>-<nonce>`). Used at startup reconcile: a crash while unlocked leaves
 * a nonce dir whose nonce (RAM-only) is gone after restart, so we match by name.
 * Unlike discardPlaintext(plan), this does not need to know the current nonce. */
export function discardProfilePlaintext(userDataDir: string, profileId: string): void {
  rmSync(join(userDataDir, 'profiles', profileId), { recursive: true, force: true })
  const partitionsRoot = join(userDataDir, 'Partitions')
  if (!existsSync(partitionsRoot)) return
  for (const entry of readdirSync(partitionsRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && isProfilePartitionDir(entry.name, profileId)) {
      rmSync(join(partitionsRoot, entry.name), { recursive: true, force: true })
    }
  }
}

/** Unlock: mount the vault and copy its dirs back out to their live userData
 * locations (no symlink — Mira reads them normally), then unmount. The plaintext
 * now exists on disk until the next lock. Throws on a wrong password. */
export async function unlock(plan: VaultPlan, password: string): Promise<void> {
  if (!existsSync(plan.bundle)) throw new Error(`no vault: ${plan.bundle}`)
  const mountPoint = await mount(plan.bundle, password)
  try {
    for (const dir of plan.dirs) replaceDir(join(mountPoint, dir.name), dir.live)
  } finally {
    await unmount(mountPoint).catch(() => unmount(mountPoint, true))
  }
}

/** Lock: mount the vault, copy the LIVE dirs back into it (they may have changed
 * while unlocked), VERIFY, unmount, then wipe the plaintext. Throws before wiping
 * if the copy can't be verified — so a failed lock never loses data. */
export async function lock(plan: VaultPlan, password: string): Promise<void> {
  if (!existsSync(plan.bundle)) throw new Error(`no vault: ${plan.bundle}`)
  const mountPoint = await mount(plan.bundle, password)
  try {
    for (const dir of plan.dirs) {
      const dest = join(mountPoint, dir.name)
      rmSync(dest, { recursive: true, force: true })
      if (existsSync(dir.live)) cpSync(dir.live, dest, { recursive: true })
    }
    for (const dir of plan.dirs) {
      if (existsSync(dir.live) && !verifyCopy(dir.live, join(mountPoint, dir.name))) {
        throw new Error(`vault copy of ${dir.name} could not be verified`)
      }
    }
  } finally {
    await unmount(mountPoint).catch(() => unmount(mountPoint, true))
  }
  // Copy verified and volume detached — wipe the plaintext.
  for (const dir of plan.dirs) rmSync(dir.live, { recursive: true, force: true })
}
