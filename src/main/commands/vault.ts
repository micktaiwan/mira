// Vault domain: the password-protected (encrypted) profile. Commands to turn a
// profile into an encrypted one, and to unlock / lock it. A profile marked
// `encrypted` keeps its data in an AES-256 sparsebundle at rest; unlocking mounts
// it and copies the data back to the normal userData locations (no symlink), so
// Mira reads it as usual, and locking re-encrypts and wipes the plaintext.
//
// The pure model (paths, which dirs, password check) is in src/main/vault.ts; the
// hdiutil / copy / wipe I/O lives behind the context slice (ProfileManager, using
// vault-service.ts). This file is the thin, validated command layer.

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'
import { isValidVaultPassword } from '../vault'

/** Vault capability slice: encrypt a profile, and unlock / lock an encrypted one. */
export interface VaultContext {
  /** Turn a profile into a password-protected one: create its vault, move its data
   * (trails + partition) in, and wipe the plaintext. Throws on the default profile,
   * an already-encrypted profile, or an open profile (close it first). */
  encryptProfile: (id: string, password: string) => Promise<{ id: string }>
  /** Unlock an encrypted profile for this session (mount + copy its data back to
   * the normal locations) so its window can open. Throws on a wrong password, an
   * unknown / non-encrypted profile. */
  unlockProfile: (id: string, password: string) => Promise<{ id: string }>
  /** Lock an unlocked encrypted profile now: close its window, copy the live data
   * back into the vault, and wipe the plaintext. No-op-safe if already locked. */
  lockProfile: (id: string) => Promise<{ id: string; locked: boolean }>
  /** The encrypted-profile state: which profile ids are encrypted, and which are
   * currently unlocked this session. */
  listVaults: () => { encrypted: string[]; unlocked: string[] }
}

interface IdParam {
  id: string
}
interface IdPasswordParams {
  id: string
  password: string
}

export const vaultCommands: CommandMap<CommandContext> = {
  'encrypt-profile': async (ctx, params) => {
    const { id, password } = (params ?? {}) as Partial<IdPasswordParams>
    if (typeof id !== 'string' || id.trim() === '') return { ok: false, error: 'missing "id"' }
    if (!isValidVaultPassword(password)) return { ok: false, error: 'missing "password"' }
    try {
      const res = await ctx.encryptProfile(id.trim(), password)
      return { ok: true, id: res.id }
    } catch (error) {
      return fail(error)
    }
  },

  'unlock-profile': async (ctx, params) => {
    const { id, password } = (params ?? {}) as Partial<IdPasswordParams>
    if (typeof id !== 'string' || id.trim() === '') return { ok: false, error: 'missing "id"' }
    if (!isValidVaultPassword(password)) return { ok: false, error: 'missing "password"' }
    try {
      const res = await ctx.unlockProfile(id.trim(), password)
      return { ok: true, id: res.id }
    } catch (error) {
      return fail(error)
    }
  },

  'lock-profile': async (ctx, params) => {
    const { id } = (params ?? {}) as Partial<IdParam>
    if (typeof id !== 'string' || id.trim() === '') return { ok: false, error: 'missing "id"' }
    try {
      const res = await ctx.lockProfile(id.trim())
      return { ok: true, id: res.id, locked: res.locked }
    } catch (error) {
      return fail(error)
    }
  },

  'list-vaults': (ctx) => {
    const { encrypted, unlocked } = ctx.listVaults()
    return { ok: true, encrypted, unlocked }
  }
}
