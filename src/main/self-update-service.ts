// Self-update for the published (unsigned) macOS build: the Electron / disk /
// process half. The decisions and the swap script are pure and tested in
// self-update.ts; read its header first.
//
// Flow, release builds only:
//   1. the daily check (update-service.ts) finds a newer release;
//   2. prepareUpdate downloads the zip, checks its SHA-256 against the published
//      checksum, unpacks it with ditto, and checks the bundle (id, version,
//      signature) before keeping it in <userData>/updates/staged/Mira.app;
//   3. a notification says it is ready; clicking it restarts Mira now;
//   4. on quit, applyStagedUpdateOnQuit spawns the detached swap script, which
//      waits for this process to exit and replaces the installed bundle.

import { app, dialog, shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  accessSync,
  constants
} from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { formatVersion, type Version } from './update-check'
import {
  INSTALL_SCRIPT,
  SIGNING_DOC_URL,
  UNSIGNED_NOTICE,
  bundlePathOf,
  distributionOf,
  isTranslocated,
  parseSha256File,
  shouldShowUnsignedNotice,
  updateAssetsFor,
  type Distribution,
  type ReleaseInfo
} from './self-update'

const run = promisify(execFile)
const BUNDLE_ID = 'com.mickaelfm.mira'

let cachedDistribution: Distribution | null = null

/** This build's distribution, read once from the packaged package.json. */
export function distribution(): Distribution {
  if (cachedDistribution) return cachedDistribution
  try {
    cachedDistribution = distributionOf(
      JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'))
    )
  } catch {
    cachedDistribution = 'local'
  }
  return cachedDistribution
}

function updatesDir(): string {
  return join(app.getPath('userData'), 'updates')
}

function stagedApp(): string {
  return join(updatesDir(), 'staged', 'Mira.app')
}

/** The version currently staged, so a second check does not download it again. */
let stagedVersion: string | null = null
/** Set by "restart now": the swap script relaunches Mira after installing. */
let relaunchAfterInstall = false

/** Where the running bundle lives, if Mira can replace it; otherwise why not. */
function installTarget(): { path: string } | { error: string } {
  const bundle = bundlePathOf(process.execPath)
  if (!bundle) return { error: 'not running from an app bundle' }
  if (isTranslocated(bundle)) {
    return {
      error: 'Mira runs from a temporary copy macOS made; move Mira.app to /Applications first'
    }
  }
  try {
    accessSync(dirname(bundle), constants.W_OK)
  } catch {
    return { error: `${dirname(bundle)} is not writable` }
  }
  return { path: bundle }
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Mira/${app.getVersion()}` },
    signal: AbortSignal.timeout(15_000)
  })
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
  return res.json()
}

/** Download `url` to `path`, returning the SHA-256 of what was written. */
async function download(url: string, path: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) })
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`)
  const hash = createHash('sha256')
  const tap = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk)
      callback(null, chunk)
    }
  })
  await pipeline(Readable.fromWeb(res.body as never), tap, createWriteStream(path))
  return hash.digest('hex')
}

async function plistValue(plist: string, key: string): Promise<string> {
  const { stdout } = await run('plutil', ['-extract', key, 'raw', plist])
  return stdout.trim()
}

/** Download, verify and stage `version` from the given release. Resolves to the
 * staged version, or rejects with a readable reason. Never touches the installed
 * bundle. */
export async function prepareUpdate(release: ReleaseInfo): Promise<Version> {
  const assets = updateAssetsFor(release, process.arch)
  if ('error' in assets) throw new Error(assets.error)
  const version = formatVersion(assets.version)
  if (stagedVersion === version && existsSync(stagedApp())) return assets.version
  const target = installTarget()
  if ('error' in target) throw new Error(target.error)

  const dir = updatesDir()
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const zip = join(dir, `Mira-${version}.zip`)

  const shaText = await (
    await fetch(assets.sha256Url, { signal: AbortSignal.timeout(30_000) })
  ).text()
  const expected = parseSha256File(shaText)
  if (!expected) throw new Error('the published checksum is unreadable')
  const actual = await download(assets.zipUrl, zip)
  if (actual !== expected)
    throw new Error(`checksum mismatch (got ${actual}, expected ${expected})`)

  const stageRoot = dirname(stagedApp())
  mkdirSync(stageRoot, { recursive: true })
  await run('ditto', ['-x', '-k', zip, stageRoot])
  rmSync(zip, { force: true })
  const plist = join(stagedApp(), 'Contents', 'Info.plist')
  if (!existsSync(plist)) throw new Error('the zip does not contain Mira.app')
  const id = await plistValue(plist, 'CFBundleIdentifier')
  if (id !== BUNDLE_ID) throw new Error(`unexpected bundle id ${id}`)
  const shipped = await plistValue(plist, 'CFBundleShortVersionString')
  if (shipped !== version) throw new Error(`the zip holds Mira ${shipped}, not ${version}`)
  // Downloaded by us, not by a browser, so it should carry no quarantine flag;
  // clear it anyway so the relaunched app never meets Gatekeeper's prompt.
  await run('xattr', ['-dr', 'com.apple.quarantine', stagedApp()]).catch(() => undefined)
  await run('codesign', ['--verify', '--deep', '--strict', stagedApp()])
  stagedVersion = version
  return assets.version
}

/** Fetch the latest release and stage it. Used by the update notice. */
export async function prepareLatestUpdate(latestUrl: string): Promise<Version> {
  return prepareUpdate((await fetchJson(latestUrl)) as ReleaseInfo)
}

/** "Restart now": install on this quit and relaunch afterwards. */
export function restartToUpdate(): void {
  relaunchAfterInstall = true
  app.quit()
}

/** On quit (will-quit), hand a staged update to the detached swap script. It
 * waits for this process to exit, so it never replaces a running bundle. */
export function applyStagedUpdateOnQuit(): void {
  if (distribution() !== 'release' || !stagedVersion || !existsSync(stagedApp())) return
  const target = installTarget()
  if ('error' in target) {
    console.error(`[mira] update not installed: ${target.error}`)
    return
  }
  const log = openSync(join(updatesDir(), 'install.log'), 'a')
  const child = spawn(
    '/bin/sh',
    [
      '-c',
      INSTALL_SCRIPT,
      'mira-install',
      String(process.pid),
      stagedApp(),
      target.path,
      relaunchAfterInstall ? '1' : '0'
    ],
    { detached: true, stdio: ['ignore', log, log] }
  )
  child.unref()
  console.log(`[mira] installing Mira ${stagedVersion} into ${target.path} after quit`)
}

function noticeStatePath(): string {
  return join(app.getPath('userData'), 'unsigned-notice.json')
}

/** At launch of a release build: explain once that it is unsigned and what that
 * costs, until the user ticks "Don't show this again". */
export async function maybeShowUnsignedNotice(): Promise<void> {
  let dismissed = false
  try {
    dismissed = JSON.parse(readFileSync(noticeStatePath(), 'utf8')).dismissed === true
  } catch {
    // No state yet: first launch.
  }
  if (!shouldShowUnsignedNotice(distribution(), dismissed)) return
  const { response, checkboxChecked } = await dialog.showMessageBox({
    type: 'info',
    message: UNSIGNED_NOTICE.message,
    detail: UNSIGNED_NOTICE.detail,
    buttons: [...UNSIGNED_NOTICE.buttons],
    defaultId: 0,
    checkboxLabel: UNSIGNED_NOTICE.checkbox,
    checkboxChecked: true
  })
  if (checkboxChecked) {
    try {
      writeFileSync(noticeStatePath(), `${JSON.stringify({ dismissed: true })}\n`)
    } catch (error) {
      console.error('[mira] unsigned notice: cannot save state', error)
    }
  }
  if (response === 1) {
    shell
      .openExternal(SIGNING_DOC_URL)
      .catch((error) => console.error('[mira] open signing doc', error))
  }
}
