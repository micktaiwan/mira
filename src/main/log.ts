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
// The naming embeds a sortable timestamp, so "rotation" is: at boot, delete all
// but the newest KEEP_RUNS files of each kind (pure logic, tested).

import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

// Enable the extensions lib's `debug` logging unconditionally. Must run before
// electron-chrome-extensions is imported (this module is index.ts's FIRST
// import), because `debug` binds its enabled-state when instances are created.
if (!process.env.DEBUG) {
  process.env.DEBUG = 'electron-chrome-extensions:*,electron-chrome-web-store:*'
}

/** How many launches' logs to keep per kind. */
export const KEEP_RUNS = 10

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

/** Among `names` (any directory listing), the log files of `kind` that should
 * be deleted to keep only the newest `keep`. Timestamps sort lexicographically,
 * so no date parsing is needed. Pure, tested. */
export function filesToPrune(names: string[], kind: 'main' | 'chromium', keep: number): string[] {
  const mine = names.filter((n) => n.startsWith(`${kind}-`) && n.endsWith('.log')).sort()
  return mine.slice(0, Math.max(0, mine.length - keep))
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

  // Rotation: keep the newest KEEP_RUNS files per kind (this launch included).
  const existing = readdirSync(logsDir)
  for (const kind of ['main', 'chromium'] as const) {
    for (const name of filesToPrune(existing, kind, KEEP_RUNS - 1)) {
      try {
        rmSync(join(logsDir, name))
      } catch {
        // Never let cleanup break boot.
      }
    }
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
