// Rotating file logging for crash forensics. Everything the app emits lands in
// files under userData/logs/, one pair per launch, oldest pruned — so when Mira
// dies (e.g. a native SIGSEGV from an extension API), the full context is on
// disk and can be read after the fact instead of reproducing the crash.
//
// Two files per launch, because there are two log worlds:
//   - main-<ts>.log    — everything written by the MAIN process JS side:
//     console.*, the `debug` package (electron-chrome-extensions), warnings.
//     Captured by teeing process.stdout/stderr, written SYNCHRONOUSLY so the
//     tail survives a segfault (a buffered stream would lose the last lines —
//     the ones that matter).
//   - chromium-<ts>.log — Chromium's own native logging (--enable-logging=file):
//     extension errors (extensions_browser_client.cc), renderer console
//     messages (INFO:CONSOLE), GPU/network internals. Chromium writes it with
//     its own handle. Trade-off: with =file these lines no longer show in the
//     dev terminal.
//
// The naming embeds a sortable timestamp. Rotation happens at boot: previous
// launches' logs are gzipped (tail-capped — after a crash only the tail
// matters), then the oldest archives are deleted so the total stays under a
// disk budget (pure logic, tested). Read an archive with `zless`/`gunzip`.

import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { gzipSync } from 'zlib'
import { join } from 'path'
import { app } from 'electron'

// Enable the extensions lib's `debug` logging unconditionally. Must run before
// electron-chrome-extensions is imported (this module is index.ts's FIRST
// import), because `debug` binds its enabled-state when instances are created.
if (!process.env.DEBUG) {
  process.env.DEBUG = 'electron-chrome-extensions:*,electron-chrome-web-store:*'
}

/** Total disk budget for archived (gzipped) logs. Text logs compress ~10:1,
 * so this holds roughly ten times as much uncompressed history. */
export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024

/** At archive time, keep at most this much of a file's tail. A log that grew
 * huge over a multi-day session is only useful near its end (the crash). */
export const MAX_TAIL_BYTES = 10 * 1024 * 1024

/** Filesystem-safe sortable timestamp: 2026-07-10T23-46-31. */
export function logTimestamp(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`
  )
}

/** The log file name for one kind and launch time. */
export function logFileName(kind: 'main' | 'chromium', at: Date): string {
  return `${kind}-${logTimestamp(at)}.log`
}

/** Sortable time key of a log file name: the kind prefix is stripped so the
 * 'main-…' and 'chromium-…' files of one launch sort together by launch time. */
export function timeKey(name: string): string {
  return name.replace(/^[a-z]+-/, '')
}

export interface ArchiveEntry {
  name: string
  size: number
}

/** Among a directory listing with sizes, the gzipped archives to delete so the
 * newest-first cumulative size stays within `budget`. Once one archive
 * overflows the budget, every older one goes too (no gaps in the kept
 * history). The newest archive always survives, even alone over budget — it is
 * the previous run, the one crash forensics needs. Pure, tested. */
export function archivesToPrune(entries: ArchiveEntry[], budget: number): string[] {
  const archives = entries
    .filter((e) => e.name.endsWith('.log.gz'))
    .sort((a, b) => timeKey(b.name).localeCompare(timeKey(a.name)))
  const doomed: string[] = []
  let total = 0
  archives.forEach((e, i) => {
    total += e.size
    if (i > 0 && total > budget) doomed.push(e.name)
  })
  return doomed
}

/** Gzip one finished log file (tail-capped) next to it and remove the
 * original. Called at boot, so no process holds the file anymore. */
function archiveLog(logsDir: string, name: string): void {
  const path = join(logsDir, name)
  const size = statSync(path).size
  const start = Math.max(0, size - MAX_TAIL_BYTES)
  const buf = Buffer.alloc(size - start)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buf, 0, buf.length, start)
  } finally {
    closeSync(fd)
  }
  writeFileSync(`${path}.gz`, gzipSync(buf))
  rmSync(path)
}

export interface LoggingPaths {
  logsDir: string
  mainLog: string
  chromiumLog: string
}

/** Install file logging. Call once, early in index.ts (after app.setName so
 * userData resolves to Mira's directory, before app ready so the Chromium
 * logging switches still apply). */
export function initLogging(userDataDir: string, now: Date = new Date()): LoggingPaths {
  const logsDir = join(userDataDir, 'logs')
  mkdirSync(logsDir, { recursive: true })

  // Rotation: gzip every previous launch's plain log (this launch's files do
  // not exist yet), then drop the oldest archives beyond the disk budget.
  for (const name of readdirSync(logsDir)) {
    if (!name.endsWith('.log')) continue
    try {
      archiveLog(logsDir, name)
    } catch {
      // Never let cleanup break boot.
    }
  }
  try {
    const entries = readdirSync(logsDir).map((name) => ({
      name,
      size: statSync(join(logsDir, name)).size
    }))
    for (const name of archivesToPrune(entries, MAX_ARCHIVE_BYTES)) {
      rmSync(join(logsDir, name))
    }
  } catch {
    // Never let cleanup break boot.
  }

  const mainLog = join(logsDir, logFileName('main', now))
  const chromiumLog = join(logsDir, logFileName('chromium', now))

  // Chromium's native logs (extension errors, renderer consoles) to their file.
  app.commandLine.appendSwitch('enable-logging', 'file')
  app.commandLine.appendSwitch('log-file', chromiumLog)

  // Tee the main process's JS output (console.*, `debug`) into mainLog,
  // synchronously — see the file header for why sync.
  let writing = false
  const tee = (stream: NodeJS.WriteStream): void => {
    const original = stream.write.bind(stream)
    stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      if (!writing) {
        writing = true
        try {
          const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
          appendFileSync(mainLog, `${new Date().toISOString()} ${text}`)
        } catch {
          // A full disk or unwritable file must never take the app down.
        }
        writing = false
      }
      return original(chunk as string, ...(rest as [BufferEncoding, () => void]))
    }) as typeof stream.write
  }
  tee(process.stdout)
  tee(process.stderr)

  // Last-breath entries for JS-side deaths (a native segfault can't be caught,
  // but the synchronous tee above means everything before it is already on disk).
  process.on('uncaughtException', (error) => {
    console.error('[mira] uncaught exception:', error)
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[mira] unhandled rejection:', reason)
  })

  return { logsDir, mainLog, chromiumLog }
}
