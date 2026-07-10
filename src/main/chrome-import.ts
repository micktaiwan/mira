// Importing cookies from a Chromium-based browser (Chrome) into a Mira session.
//
// macOS Chromium encrypts each cookie's value with AES-128-CBC. The key is
// PBKDF2(SHA-1, salt="saltysalt", 1003 rounds, 16 bytes) over the app's Keychain
// "<App> Safe Storage" password; the stored blob is prefixed with "v10". Recent
// Chrome (M124+) also prepends a 32-byte SHA-256 domain hash to the plaintext
// before encryption. Verified against two full Chrome profiles (2494 + 4482
// cookies): 100% follow this exact shape.
//
// This split keeps the crypto + row→cookie mapping PURE and unit-tested; the
// Keychain / SQLite reads are thin I/O helpers used by the import-cookies
// command. NOTE: this scheme does NOT decrypt ChatGPT Atlas cookies — Atlas uses
// a hardened, app-bound encryption that this (standard) path cannot read.

import { pbkdf2Sync, createDecipheriv } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SALT = 'saltysalt'
const ITERATIONS = 1003
const KEY_LENGTH = 16
const IV = Buffer.alloc(16, 0x20) // 16 spaces
const DOMAIN_HASH_LENGTH = 32
/** Microseconds between 1601-01-01 (Chrome epoch) and 1970-01-01 (Unix epoch). */
const CHROME_EPOCH_OFFSET_MICROS = 11644473600000000

/** Derive the AES key from a "… Safe Storage" Keychain password. */
export function deriveKey(safeStoragePassword: string): Buffer {
  return pbkdf2Sync(safeStoragePassword, SALT, ITERATIONS, KEY_LENGTH, 'sha1')
}

/** Decrypt one Chrome `encrypted_value` blob to its cleartext cookie value.
 * Throws if the blob is not the expected "v10" CBC form. */
export function decryptValue(key: Buffer, encrypted: Buffer): string {
  const prefix = encrypted.subarray(0, 3).toString('latin1')
  if (prefix !== 'v10') throw new Error(`unsupported cookie encryption prefix: ${prefix}`)
  const decipher = createDecipheriv('aes-128-cbc', key, IV)
  decipher.setAutoPadding(false)
  const padded = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()])
  // Strip PKCS#7 padding by hand (autopadding off so a wrong key never throws here).
  const pad = padded[padded.length - 1]
  const unpadded = pad > 0 && pad <= 16 ? padded.subarray(0, padded.length - pad) : padded
  // Drop the 32-byte domain-hash prefix Chrome prepends before encryption.
  return unpadded.subarray(DOMAIN_HASH_LENGTH).toString('utf8')
}

/** SameSite as Chrome stores it (-1/0/1/2) → the Electron cookies.set enum. */
export function sameSite(n: number): CookieSetDetails['sameSite'] {
  switch (n) {
    case 0:
      return 'no_restriction'
    case 1:
      return 'lax'
    case 2:
      return 'strict'
    default:
      return 'unspecified'
  }
}

/** Chrome `expires_utc` (microseconds since 1601) → Unix seconds, or undefined
 * for a session cookie (expires_utc 0). */
export function expiryToUnixSeconds(expiresUtc: number): number | undefined {
  if (!expiresUtc || expiresUtc <= 0) return undefined
  return (expiresUtc - CHROME_EPOCH_OFFSET_MICROS) / 1_000_000
}

/** Build the URL a cookie belongs to. Its scheme mirrors the Secure flag so a
 * Secure cookie is set over an https origin (Electron rejects Secure-over-http). */
export function cookieUrl(hostKey: string, isSecure: boolean, path: string): string {
  const host = hostKey.replace(/^\./, '')
  const scheme = isSecure ? 'https' : 'http'
  const p = path && path.startsWith('/') ? path : '/'
  return `${scheme}://${host}${p}`
}

/** One row of Chrome's `cookies` table, as read by readCookieRows. */
export interface ChromeCookieRow {
  host_key: string
  name: string
  path: string
  expires_utc: number
  is_secure: number
  is_httponly: number
  samesite: number
  /** hex of encrypted_value ('' when the cookie is stored in cleartext). */
  encrypted_hex: string
  /** the cleartext `value` column (used only when encrypted_hex is empty). */
  value: string
}

/** The subset of Electron's CookiesSetDetails we produce. */
export interface CookieSetDetails {
  url: string
  name: string
  value: string
  domain?: string
  path: string
  secure: boolean
  httpOnly: boolean
  expirationDate?: number
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
}

/** Map a Chrome cookie row + its decrypted value to Electron cookies.set params. */
export function rowToSetDetails(row: ChromeCookieRow, value: string): CookieSetDetails {
  const isSecure = row.is_secure === 1
  const details: CookieSetDetails = {
    url: cookieUrl(row.host_key, isSecure, row.path),
    name: row.name,
    value,
    path: row.path && row.path.startsWith('/') ? row.path : '/',
    secure: isSecure,
    httpOnly: row.is_httponly === 1,
    sameSite: sameSite(row.samesite)
  }
  // A leading dot marks a domain cookie (valid across subdomains): pass it as
  // `domain`. A host-only cookie omits `domain` to stay scoped to the exact host.
  if (row.host_key.startsWith('.')) details.domain = row.host_key
  const exp = expiryToUnixSeconds(row.expires_utc)
  if (exp !== undefined) details.expirationDate = exp
  return details
}

// --- Thin I/O helpers (not unit-tested; exercised by the import-cookies command) ---

/** Read a browser's "… Safe Storage" key from the login Keychain. The first read
 * pops a one-time macOS authorization prompt. */
export function readSafeStorageKey(service = 'Chrome Safe Storage'): string {
  return execFileSync('security', ['find-generic-password', '-w', '-s', service], {
    encoding: 'utf8'
  }).trim()
}

const FIELD = '\x1f'
const RECORD = '\x1e'

/** Read all rows of a Chrome `Cookies` SQLite DB. Copies the file first so a
 * running Chrome (which locks the live DB) does not block the read. */
export function readCookieRows(cookiesDbPath: string): ChromeCookieRow[] {
  const tmp = join(tmpdir(), `mira-chrome-cookies-${process.pid}.sqlite`)
  copyFileSync(cookiesDbPath, tmp)
  const query =
    'select host_key, name, path, expires_utc, is_secure, is_httponly, samesite, ' +
    "hex(encrypted_value), coalesce(value,'') from cookies"
  const out = execFileSync('sqlite3', [tmp, '-newline', RECORD, '-separator', FIELD, query], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024
  })
  return out
    .split(RECORD)
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
    .map((r) => {
      const f = r.split(FIELD)
      return {
        host_key: f[0],
        name: f[1],
        path: f[2],
        expires_utc: Number(f[3]),
        is_secure: Number(f[4]),
        is_httponly: Number(f[5]),
        samesite: Number(f[6]),
        encrypted_hex: f[7] ?? '',
        value: f[8] ?? ''
      }
    })
}
