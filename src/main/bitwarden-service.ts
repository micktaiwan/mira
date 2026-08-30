// The thin NATIVE edge that runs the Bitwarden CLI. Every decision it makes was
// taken in bitwarden.ts (pure, unit-tested); this file only spawns `bw`, feeds
// it, and keeps the unlocked session key in memory.
//
// Three rules this file exists to enforce, each paid for by a real failure mode:
//
//   1. NEVER let bw prompt. With no session, `bw` asks "Master password:" on the
//      terminal and blocks forever (reproduced on 2026-08-13). Mira has no
//      terminal, so stdin is closed immediately and every call is timed out.
//   2. NEVER put a secret in argv. The card goes in on STDIN (`bw create item`
//      reads it there) and the master password goes in through an ENV VAR
//      (`bw unlock --passwordenv`). Neither shows up in `ps`.
//   3. NEVER cross accounts. Each call carries BITWARDENCLI_APPDATA_DIR for its
//      own vault, and an inherited BW_SESSION from Mira's own environment is
//      stripped (bwEnv) so a pro session key can never be used to write a card.
//
// The session key lives in RAM only, per vault directory, exactly like the
// profile vault password in profiles.ts. Quitting Mira forgets it.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  bwBinaryCandidates,
  bwEnv,
  classifyFailure,
  encodeItem,
  parseCardItems,
  parseCreatedId,
  parseStatus,
  type BwFailure,
  type CardVault,
  type StoredCard,
  type VaultStatus
} from './bitwarden'
import { cardItem } from './bitwarden'
import {
  encodeBwItem,
  loginItem,
  parseLoginItems,
  withExtraUri,
  withNewPassword,
  type VaultLogin
} from './bitwarden-login'
import type { ValidatedCard } from './card'
import type { ValidatedLogin } from './login-capture'

/** A bw invocation that failed, with the reason the UI acts on. */
export class BitwardenError extends Error {
  constructor(
    readonly reason: BwFailure,
    message: string
  ) {
    super(message)
    this.name = 'BitwardenError'
  }
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

/** How long any single bw call may take before it is killed. Generous: `bw
 * create` talks to the server. */
const TIMEOUT_MS = 30_000

export class BitwardenService {
  /** appDataDir → session key, for vaults unlocked during this run. RAM only. */
  private readonly sessions = new Map<string, string>()
  private resolvedBinary: string | null = null

  constructor(private readonly binary?: string) {}

  /** The bw executable to spawn: the first candidate that exists on disk, else a
   * bare 'bw' (which fails with a clear "not found" rather than silently). */
  private bwBinary(): string {
    if (this.binary) return this.binary
    if (this.resolvedBinary) return this.resolvedBinary
    const candidates = bwBinaryCandidates(process.env)
    const found = candidates.find((path) => path.includes('/') && existsSync(path))
    return (this.resolvedBinary = found ?? 'bw')
  }

  /** Whether this vault is usable right now without asking anything. */
  hasSession(vault: CardVault): boolean {
    return this.sessions.has(vault.appDataDir)
  }

  /** Forget a vault's session (used when bw rejects it as stale). */
  forget(vault: CardVault): void {
    this.sessions.delete(vault.appDataDir)
  }

  /** What `bw status` says. Never throws for a locked/logged-out vault — those
   * are answers, not errors. */
  async status(vault: CardVault): Promise<VaultStatus> {
    try {
      const { stdout } = await this.run(['status'], vault)
      return parseStatus(stdout)
    } catch (error) {
      if (error instanceof BitwardenError && error.reason === 'not-installed') throw error
      return { state: 'unknown' }
    }
  }

  /** Unlock with the master password and keep the session key in memory. The
   * password crosses through the child's environment, never argv. */
  async unlock(vault: CardVault, password: string): Promise<void> {
    if (!password) throw new BitwardenError('locked', 'missing master password')
    const { stdout } = await this.run(['unlock', '--raw', '--passwordenv', 'MIRA_BW_PASSWORD'], {
      vault,
      extraEnv: { MIRA_BW_PASSWORD: password }
    })
    const session = stdout.trim()
    if (!session) throw new BitwardenError('locked', 'bw returned no session key')
    this.sessions.set(vault.appDataDir, session)
  }

  /** Write the card into the vault as a Bitwarden card item, returning its id.
   * Throws BitwardenError('locked') when the vault needs unlocking — the caller
   * turns that into a password prompt rather than a dead end. */
  async saveCard(vault: CardVault, card: ValidatedCard, now: Date): Promise<string | null> {
    const session = this.sessions.get(vault.appDataDir)
    if (!session) throw new BitwardenError('locked', 'vault is locked')
    const encoded = encodeItem(cardItem(card, now))
    try {
      const { stdout } = await this.run(['create', 'item'], { vault, session, stdin: encoded })
      return parseCreatedId(stdout)
    } catch (error) {
      // A session key that bw refuses is worse than none: drop it so the next
      // attempt asks for the password instead of failing the same way forever.
      if (error instanceof BitwardenError && error.reason === 'locked') this.forget(vault)
      throw error
    }
  }

  /** Every CARD in the vault (never the full numbers — see StoredCard). Throws
   * BitwardenError('locked') when there is no session key yet. */
  async listCards(vault: CardVault): Promise<StoredCard[]> {
    if (!this.sessions.has(vault.appDataDir)) {
      throw new BitwardenError('locked', 'vault is locked')
    }
    try {
      // `bw list items` returns the WHOLE vault; the type filter is ours.
      const { stdout } = await this.run(['list', 'items'], vault)
      return parseCardItems(stdout)
    } catch (error) {
      if (error instanceof BitwardenError && error.reason === 'locked') this.forget(vault)
      throw error
    }
  }

  /** Write a login into the vault as a Bitwarden login item, returning its id.
   * The password goes in on STDIN like a card number, never in argv. */
  async saveLogin(vault: CardVault, login: ValidatedLogin, now: Date): Promise<string | null> {
    const session = this.sessions.get(vault.appDataDir)
    if (!session) throw new BitwardenError('locked', 'vault is locked')
    const encoded = encodeBwItem(loginItem(login, now))
    try {
      const { stdout } = await this.run(['create', 'item'], { vault, session, stdin: encoded })
      return parseCreatedId(stdout)
    } catch (error) {
      if (error instanceof BitwardenError && error.reason === 'locked') this.forget(vault)
      throw error
    }
  }

  /** Replace an existing login's password, carrying every other field of the item
   * through untouched (`bw edit item` replaces the WHOLE item, so a partial
   * payload would silently drop its uris, notes and custom fields). */
  async updateLogin(vault: CardVault, existing: VaultLogin, password: string): Promise<void> {
    const session = this.sessions.get(vault.appDataDir)
    if (!session) throw new BitwardenError('locked', 'vault is locked')
    if (!existing.id) throw new BitwardenError('failed', 'vault item has no id')
    const encoded = encodeBwItem(withNewPassword(existing, password))
    try {
      // The id is a UUID, not a secret, so argv is fine; the password is on stdin.
      await this.run(['edit', 'item', existing.id], { vault, session, stdin: encoded })
    } catch (error) {
      if (error instanceof BitwardenError && error.reason === 'locked') this.forget(vault)
      throw error
    }
  }

  /** Record one more address on an existing login (`bw edit item`), used when the
   * very same credential is typed on another subdomain of a site the vault
   * already covers. Nothing else about the item changes — in particular NOT the
   * password, which is why this call needs no confirmation: it cannot lose a
   * secret, it can only make the item findable next time. */
  async linkLoginUri(vault: CardVault, existing: VaultLogin, uri: string): Promise<void> {
    const session = this.sessions.get(vault.appDataDir)
    if (!session) throw new BitwardenError('locked', 'vault is locked')
    if (!existing.id) throw new BitwardenError('failed', 'vault item has no id')
    const encoded = encodeBwItem(withExtraUri(existing, uri))
    try {
      await this.run(['edit', 'item', existing.id], { vault, session, stdin: encoded })
    } catch (error) {
      if (error instanceof BitwardenError && error.reason === 'locked') this.forget(vault)
      throw error
    }
  }

  /** Every LOGIN in the vault, WITH its password: this feeds the "is this account
   * already saved, under the same password or another one?" decision, and it is
   * the caller's job to redact before anything leaves the main process
   * (redactLogins in bitwarden-login.ts). Throws BitwardenError('locked') when
   * there is no session key yet. */
  async listLogins(vault: CardVault): Promise<VaultLogin[]> {
    if (!this.sessions.has(vault.appDataDir)) {
      throw new BitwardenError('locked', 'vault is locked')
    }
    try {
      // `bw list items` returns the WHOLE vault; the type filter is ours.
      const { stdout } = await this.run(['list', 'items'], vault)
      return parseLoginItems(stdout)
    } catch (error) {
      if (error instanceof BitwardenError && error.reason === 'locked') this.forget(vault)
      throw error
    }
  }

  /** Send one card to the vault's trash (a soft delete — `--permanent` is
   * deliberately NOT used, so a wrong id is recoverable from Bitwarden's own
   * trash). The id is a UUID, not a secret, so argv is fine here. */
  async deleteItem(vault: CardVault, id: string): Promise<void> {
    if (!this.sessions.has(vault.appDataDir)) {
      throw new BitwardenError('locked', 'vault is locked')
    }
    try {
      await this.run(['delete', 'item', id], vault)
    } catch (error) {
      if (error instanceof BitwardenError && error.reason === 'locked') this.forget(vault)
      throw error
    }
  }

  /** Spawn one bw call. `vault` may be passed alone for the common case. */
  private run(
    args: string[],
    options:
      | CardVault
      | {
          vault: CardVault
          session?: string
          stdin?: string
          extraEnv?: NodeJS.ProcessEnv
        }
  ): Promise<RunResult> {
    const opts = 'appDataDir' in options ? { vault: options } : options
    const session = opts.session ?? this.sessions.get(opts.vault.appDataDir) ?? null
    const env = { ...bwEnv(process.env, opts.vault, session), ...(opts.extraEnv ?? {}) }
    return new Promise<RunResult>((resolve, reject) => {
      const child = spawn(this.bwBinary(), args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGKILL')
        reject(new BitwardenError('failed', `bw ${args[0]} timed out`))
      }, TIMEOUT_MS)
      child.stdout.on('data', (chunk) => (stdout += String(chunk)))
      child.stderr.on('data', (chunk) => (stderr += String(chunk)))
      child.on('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new BitwardenError(classifyFailure(String(error)), String(error)))
      })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (code === 0) resolve({ code, stdout, stderr })
        else reject(new BitwardenError(classifyFailure(stderr), stderr.trim() || `bw exit ${code}`))
      })
      // Feed stdin and close it at once: an open stdin is what lets bw sit on a
      // "Master password:" prompt forever.
      if (opts.stdin) child.stdin.write(opts.stdin)
      child.stdin.end()
    })
  }
}
