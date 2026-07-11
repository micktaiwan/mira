// Unit tests for the fs-only part of vault-service (no hdiutil, so unguarded — the
// real sparsebundle round-trip is exercised by vault-service.integration.test.ts,
// which is gated behind MIRA_VAULT_IT). Here we only cover discardProfilePlaintext,
// which wipes an encrypted profile's leftover plaintext by NAME.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { discardProfilePlaintext } from './vault-service'

const ID = 'abc-123'

describe('discardProfilePlaintext', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mira-vault-test-'))
    // The profile's trails dir + a couple of partition dirs (canonical + nonce),
    // plus dirs belonging to OTHER sessions that must survive.
    mkdirSync(join(dir, 'profiles', ID), { recursive: true })
    writeFileSync(join(dir, 'profiles', ID, 'history.json'), '[]')
    mkdirSync(join(dir, 'Partitions', `mira-${ID}`), { recursive: true })
    mkdirSync(join(dir, 'Partitions', `mira-${ID}-ff00`), { recursive: true })
    mkdirSync(join(dir, 'Partitions', `mira-${ID}-ab99`), { recursive: true })
    mkdirSync(join(dir, 'Partitions', 'mira-other'), { recursive: true })
    mkdirSync(join(dir, 'Partitions', 'mira-chrome'), { recursive: true })
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('wipes the trails dir and EVERY partition dir of the profile (canonical + nonces)', () => {
    discardProfilePlaintext(dir, ID)
    expect(existsSync(join(dir, 'profiles', ID))).toBe(false)
    expect(existsSync(join(dir, 'Partitions', `mira-${ID}`))).toBe(false)
    expect(existsSync(join(dir, 'Partitions', `mira-${ID}-ff00`))).toBe(false)
    expect(existsSync(join(dir, 'Partitions', `mira-${ID}-ab99`))).toBe(false)
  })

  it('leaves other profiles / sessions untouched', () => {
    discardProfilePlaintext(dir, ID)
    expect(existsSync(join(dir, 'Partitions', 'mira-other'))).toBe(true)
    expect(existsSync(join(dir, 'Partitions', 'mira-chrome'))).toBe(true)
  })

  it('is a no-op (no throw) when nothing is there', () => {
    const empty = mkdtempSync(join(tmpdir(), 'mira-vault-empty-'))
    expect(() => discardProfilePlaintext(empty, ID)).not.toThrow()
    rmSync(empty, { recursive: true, force: true })
  })
})
