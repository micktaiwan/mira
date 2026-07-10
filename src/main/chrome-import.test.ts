import { describe, it, expect } from 'vitest'
import { createCipheriv, randomBytes } from 'node:crypto'
import {
  deriveKey,
  decryptValue,
  sameSite,
  expiryToUnixSeconds,
  cookieUrl,
  rowToSetDetails,
  type ChromeCookieRow
} from './chrome-import'

/** Encrypt a value the way macOS Chrome does, so decryptValue can be tested
 * against a known plaintext without touching a real cookie DB: 32-byte domain
 * hash prefix + value, PKCS#7-padded, AES-128-CBC, "v10" prefix. */
function encryptLikeChrome(key: Buffer, value: string): Buffer {
  const domainHash = randomBytes(32)
  const plain = Buffer.concat([domainHash, Buffer.from(value, 'utf8')])
  // PKCS#7: pad length is 1..16 (a full block when already aligned), byte = length.
  const padLen = 16 - (plain.length % 16)
  const padded = Buffer.concat([plain, Buffer.alloc(padLen, padLen)])
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  cipher.setAutoPadding(false)
  const body = Buffer.concat([cipher.update(padded), cipher.final()])
  return Buffer.concat([Buffer.from('v10'), body])
}

describe('decryptValue', () => {
  const key = deriveKey('some-safe-storage-password')

  it('round-trips a value through the Chrome v10 scheme', () => {
    const blob = encryptLikeChrome(key, 'session-token=abc123')
    expect(decryptValue(key, blob)).toBe('session-token=abc123')
  })

  it('handles a value whose length lands on a block boundary', () => {
    // 16-char value → padded plaintext is an exact multiple after the 32-byte hash.
    const blob = encryptLikeChrome(key, 'sixteencharvalue')
    expect(decryptValue(key, blob)).toBe('sixteencharvalue')
  })

  it('throws on a non-v10 blob', () => {
    expect(() => decryptValue(key, Buffer.from('v11garbage'))).toThrow(/unsupported/)
  })
})

describe('sameSite', () => {
  it('maps Chrome integer flags to the Electron enum', () => {
    expect(sameSite(-1)).toBe('unspecified')
    expect(sameSite(0)).toBe('no_restriction')
    expect(sameSite(1)).toBe('lax')
    expect(sameSite(2)).toBe('strict')
    expect(sameSite(99)).toBe('unspecified')
  })
})

describe('expiryToUnixSeconds', () => {
  it('converts a Chrome (1601-epoch, microseconds) timestamp to Unix seconds', () => {
    // Chrome-epoch value for Unix second 1: offset + 1_000_000 microseconds.
    expect(expiryToUnixSeconds(11644473600000000 + 1_000_000)).toBe(1)
  })

  it('treats expires_utc 0 as a session cookie (undefined)', () => {
    expect(expiryToUnixSeconds(0)).toBeUndefined()
  })
})

describe('cookieUrl', () => {
  it('uses https for a Secure cookie and strips a leading dot', () => {
    expect(cookieUrl('.github.com', true, '/')).toBe('https://github.com/')
  })

  it('uses http for a non-Secure cookie and defaults an empty path to /', () => {
    expect(cookieUrl('example.com', false, '')).toBe('http://example.com/')
  })
})

describe('rowToSetDetails', () => {
  const base: ChromeCookieRow = {
    host_key: '.github.com',
    name: 'user_session',
    path: '/',
    expires_utc: 11644473600000000 + 1_000_000,
    is_secure: 1,
    is_httponly: 1,
    samesite: 2,
    encrypted_hex: '',
    value: ''
  }

  it('maps a domain cookie, keeping the leading-dot domain', () => {
    const d = rowToSetDetails(base, 'tok')
    expect(d).toMatchObject({
      url: 'https://github.com/',
      name: 'user_session',
      value: 'tok',
      domain: '.github.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'strict',
      expirationDate: 1
    })
  })

  it('omits domain for a host-only cookie (no leading dot)', () => {
    const d = rowToSetDetails({ ...base, host_key: 'app.example.com' }, 'v')
    expect(d.domain).toBeUndefined()
    expect(d.url).toBe('https://app.example.com/')
  })

  it('omits expirationDate for a session cookie', () => {
    const d = rowToSetDetails({ ...base, expires_utc: 0 }, 'v')
    expect(d.expirationDate).toBeUndefined()
  })
})
