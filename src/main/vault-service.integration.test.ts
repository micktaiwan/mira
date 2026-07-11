// REAL integration test for the encrypted-profile native edge (vault-service.ts).
// It actually shells out to /usr/bin/hdiutil and creates/mounts/wipes a real
// AES-256 sparsebundle in a THROWAWAY temp dir — so it is NOT part of the normal
// suite. It is skipped unless you opt in:
//
//   MIRA_VAULT_IT=1 npx vitest run vault-service.integration
//
// This is the validation harness for the destructive native paths (encrypt / lock
// wipe the plaintext) before trusting them with a real profile. macOS only.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { vaultPlan } from './vault'
import { encrypt, unlock, lock, discardPlaintext } from './vault-service'

const ENABLED = process.env.MIRA_VAULT_IT === '1' && process.platform === 'darwin'
const PASSWORD = 'test-passphrase'
const PROFILE_ID = 'it-profile'

describe.skipIf(!ENABLED)('vault-service (real hdiutil)', () => {
  let userDataDir: string
  let plan: ReturnType<typeof vaultPlan>

  /** Recreate the profile's plaintext live dirs with known sample files. */
  function seedLive(): void {
    for (const dir of plan.dirs) {
      mkdirSync(dir.live, { recursive: true })
      writeFileSync(join(dir.live, 'sample.txt'), `hello from ${dir.name}`)
    }
  }

  beforeAll(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'mira-vault-it-'))
    plan = vaultPlan(userDataDir, PROFILE_ID)
    seedLive()
  })

  afterAll(() => {
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it(
    'encrypt: builds the vault and wipes the plaintext',
    async () => {
      await encrypt(plan, PASSWORD)
      expect(existsSync(plan.bundle)).toBe(true)
      for (const dir of plan.dirs) expect(existsSync(dir.live)).toBe(false)
    },
    120_000
  )

  it(
    'unlock: restores the plaintext from the vault, intact',
    async () => {
      await unlock(plan, PASSWORD)
      for (const dir of plan.dirs) {
        expect(readFileSync(join(dir.live, 'sample.txt'), 'utf8')).toBe(`hello from ${dir.name}`)
      }
    },
    120_000
  )

  it(
    'lock then unlock: a change made while unlocked persists into the vault',
    async () => {
      // Modify a live file, then lock (copy back into the vault + wipe).
      writeFileSync(join(plan.dirs[0].live, 'sample.txt'), 'edited while unlocked')
      await lock(plan, PASSWORD)
      for (const dir of plan.dirs) expect(existsSync(dir.live)).toBe(false)
      // Re-unlock: the edit must be there (the vault captured it).
      await unlock(plan, PASSWORD)
      expect(readFileSync(join(plan.dirs[0].live, 'sample.txt'), 'utf8')).toBe('edited while unlocked')
    },
    180_000
  )

  it(
    'unlock with the wrong password is rejected',
    async () => {
      // (Data is currently unlocked on disk from the previous test; re-locking it
      // first would need the right password — instead we just assert the mount fails
      // by attempting an unlock on the vault with a bad password.)
      await expect(unlock(plan, 'not-the-password')).rejects.toThrow(/wrong password/i)
    },
    120_000
  )

  it('discardPlaintext: wipes the live dirs, leaves the vault', () => {
    // Live dirs are present (unlocked). Discard them (the startup-reconcile path).
    for (const dir of plan.dirs) expect(existsSync(dir.live)).toBe(true)
    discardPlaintext(plan)
    for (const dir of plan.dirs) expect(existsSync(dir.live)).toBe(false)
    expect(existsSync(plan.bundle)).toBe(true)
  })
})
