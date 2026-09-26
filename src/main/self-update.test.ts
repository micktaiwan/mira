import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  INSTALL_SCRIPT,
  assetName,
  bundlePathOf,
  distributionOf,
  isTranslocated,
  parseSha256File,
  shouldShowUnsignedNotice,
  updateAssetsFor
} from './self-update'

describe('distributionOf', () => {
  it('is release only when bin/release.sh stamped it', () => {
    expect(distributionOf({ miraDistribution: 'release' })).toBe('release')
    expect(distributionOf({ miraDistribution: 'other' })).toBe('local')
    expect(distributionOf({})).toBe('local')
    expect(distributionOf(null)).toBe('local')
  })
})

describe('updateAssetsFor', () => {
  const url = (n: string): string =>
    `https://github.com/micktaiwan/mira/releases/download/v1.2.0/${n}`
  const zip = 'Mira-1.2.0-mac-arm64.zip'

  it('picks the zip and its checksum for this arch', () => {
    const r = updateAssetsFor(
      {
        tag_name: 'v1.2.0',
        assets: [
          { name: zip, browser_download_url: url(zip) },
          { name: `${zip}.sha256`, browser_download_url: url(`${zip}.sha256`) },
          { name: 'Mira-1.2.0-mac-x64.zip', browser_download_url: url('x') }
        ]
      },
      'arm64'
    )
    expect(r).toEqual({ version: [1, 2, 0], zipUrl: url(zip), sha256Url: url(`${zip}.sha256`) })
  })

  it('refuses a zip without its checksum', () => {
    const r = updateAssetsFor(
      { tag_name: 'v1.2.0', assets: [{ name: zip, browser_download_url: url(zip) }] },
      'arm64'
    )
    expect(r).toMatchObject({ error: expect.stringContaining('.sha256') })
  })

  it('refuses a download host other than GitHub', () => {
    const r = updateAssetsFor(
      {
        tag_name: 'v1.2.0',
        assets: [
          { name: zip, browser_download_url: 'https://evil.example/Mira.zip' },
          { name: `${zip}.sha256`, browser_download_url: url(`${zip}.sha256`) }
        ]
      },
      'arm64'
    )
    expect(r).toMatchObject({ error: expect.stringContaining('refusing') })
  })

  it('names assets the way bin/release.sh does', () => {
    expect(assetName([1, 2, 0], 'arm64')).toBe('Mira-1.2.0-mac-arm64.zip')
  })
})

describe('parseSha256File', () => {
  const hex = 'a'.repeat(64)
  it('reads the shasum format', () => {
    expect(parseSha256File(`${hex}  Mira-1.2.0-mac-arm64.zip\n`)).toBe(hex)
    expect(parseSha256File('nope')).toBeNull()
  })
})

describe('bundlePathOf / isTranslocated', () => {
  it('finds the .app around the executable', () => {
    expect(bundlePathOf('/Applications/Mira.app/Contents/MacOS/Mira')).toBe(
      '/Applications/Mira.app'
    )
    expect(bundlePathOf('/repo/node_modules/electron/dist/Electron')).toBeNull()
  })

  it('spots App Translocation', () => {
    expect(isTranslocated('/private/var/folders/x/AppTranslocation/ABC/d/Mira.app')).toBe(true)
    expect(isTranslocated('/Applications/Mira.app')).toBe(false)
  })
})

describe('shouldShowUnsignedNotice', () => {
  it('shows on a release build until dismissed, never on a local build', () => {
    expect(shouldShowUnsignedNotice('release', false)).toBe(true)
    expect(shouldShowUnsignedNotice('release', true)).toBe(false)
    expect(shouldShowUnsignedNotice('local', false)).toBe(false)
  })
})

describe.runIf(process.platform === 'darwin')('INSTALL_SCRIPT (runs for real)', () => {
  const deadPid = (): string => {
    // A pid that existed and is gone: the script must not wait on it.
    const out = execFileSync('/bin/sh', ['-c', 'true & echo $!']).toString().trim()
    return out
  }

  function fixture(): { dir: string; staged: string; target: string } {
    const dir = mkdtempSync(join(tmpdir(), 'mira-install-'))
    const staged = join(dir, 'staged', 'Mira.app')
    const target = join(dir, 'Applications', 'Mira.app')
    mkdirSync(join(staged, 'Contents'), { recursive: true })
    mkdirSync(join(target, 'Contents'), { recursive: true })
    writeFileSync(join(staged, 'Contents', 'version'), 'new')
    writeFileSync(join(target, 'Contents', 'version'), 'old')
    return { dir, staged, target }
  }

  it('swaps the bundle once the process is gone, and cleans up', () => {
    const { staged, target } = fixture()
    execFileSync('/bin/sh', ['-c', INSTALL_SCRIPT, 'mira-install', deadPid(), staged, target, '0'])
    expect(readFileSync(join(target, 'Contents', 'version'), 'utf8')).toBe('new')
    expect(existsSync(`${target}.previous`)).toBe(false)
    expect(existsSync(staged)).toBe(false)
  })

  it('keeps the installed Mira when the staged bundle is missing', () => {
    const { dir, target } = fixture()
    execFileSync('/bin/sh', [
      '-c',
      INSTALL_SCRIPT,
      'mira-install',
      deadPid(),
      join(dir, 'nope.app'),
      target,
      '0'
    ])
    expect(readFileSync(join(target, 'Contents', 'version'), 'utf8')).toBe('old')
  })
})
