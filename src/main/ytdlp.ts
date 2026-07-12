// yt-dlp integration: download a STREAMED video (MSE/HLS/blob — e.g. X, YouTube)
// as a real file by delegating to the yt-dlp CLI. This replaces the old
// captureStream/MediaRecorder recorder, whose fatal flaw was capturing the stream
// WHILE it played in the page: the tab had to stay open on that page for the whole
// clip. yt-dlp resolves and muxes the segments itself, so the download runs in the
// background with nothing kept open — a true file download.
//
// It needs a PRECISE per-media page URL (the permalink for THAT video, resolved
// from the DOM — see media-collect.ts), never the tab URL: a timeline page holds
// many videos and its URL designates none of them.
//
// The pure parts (PATH augmentation, the arg list, the output parsers) are unit
// tested; only the spawn itself is the thin, untested native shell.

import { spawn } from 'node:child_process'

/** Bin dirs commonly holding CLI tools (Homebrew, pyenv, ~/.local), in priority
 * order — prepended to PATH so a Finder/Dock-launched app (which inherits
 * launchd's minimal PATH, not the shell's) still finds yt-dlp. Mirrors swiss's
 * process.rs. Pure. */
export function extraBinDirs(home: string | undefined): string[] {
  const dirs = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin']
  if (home) dirs.push(`${home}/.pyenv/shims`, `${home}/.local/bin`, `${home}/.cargo/bin`)
  return dirs
}

/** Build an augmented PATH: extra bin dirs first, then the inherited PATH, with
 * empties and duplicates dropped so the value stays compact. Pure. */
export function augmentedPath(inherited: string | undefined, home: string | undefined): string {
  const seen = new Set<string>()
  const parts: string[] = []
  for (const dir of [...extraBinDirs(home), ...(inherited ?? '').split(':')]) {
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    parts.push(dir)
  }
  return parts.join(':')
}

/** The yt-dlp argument list to download `url` into `outputDir`. Pure — the flags
 * mirror swiss's proven set: a clean title-based filename, print the final path
 * so we can report it, ASCII-restricted names, newline progress. `--no-playlist`
 * keeps a single video (a tweet/channel URL can otherwise expand to many). */
export function ytdlpArgs(url: string, outputDir: string): string[] {
  return [
    '-o',
    `${outputDir}/%(title).100s.%(ext)s`,
    '--restrict-filenames',
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--print',
    'after_move:filepath',
    url
  ]
}

/** Parse a `[download]  42.3%` progress line into a 0–100 number, or null when the
 * line is not a progress line. Pure. */
export function parseProgress(line: string): number | null {
  const m = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(line)
  if (!m) return null
  const p = Number(m[1])
  return Number.isFinite(p) ? Math.min(100, p) : null
}

/** Pick the saved filepath from yt-dlp stdout: `--print after_move:filepath`
 * prints it as a bare line (progress/status lines start with '['). Returns the
 * last bare line, or '' if none. Pure. */
export function pickFilepath(stdout: string): string {
  let file = ''
  for (const raw of stdout.split('\n')) {
    const t = raw.trim()
    if (t && !t.startsWith('[')) file = t
  }
  return file
}

export interface YtdlpResult {
  saved: boolean
  /** Basename of the saved file, on success. */
  file?: string
  error?: string
}

/** Download `url` to `outputDir` with yt-dlp, PATH augmented so a GUI-launched
 * app finds the binary. Resolves with the saved file's basename, or a clean error
 * (missing binary / non-zero exit) — never rejects. `onProgress` gets 0–100. */
export async function ytdlpDownload(
  url: string,
  outputDir: string,
  env: NodeJS.ProcessEnv,
  onProgress?: (pct: number) => void
): Promise<YtdlpResult> {
  return new Promise((resolve) => {
    let settled = false
    const done = (r: YtdlpResult): void => {
      if (settled) return
      settled = true
      resolve(r)
    }
    const child = spawn('yt-dlp', ytdlpArgs(url, outputDir), {
      env: { ...env, PATH: augmentedPath(env.PATH, env.HOME) }
    })
    let stdout = ''
    const errTail: string[] = []
    child.stdout.on('data', (d) => {
      stdout += String(d)
    })
    child.stderr.on('data', (d) => {
      for (const line of String(d).split('\n')) {
        if (!line.trim()) continue
        const pct = parseProgress(line)
        if (pct != null) onProgress?.(pct)
        errTail.push(line.trim())
        if (errTail.length > 8) errTail.shift()
      }
    })
    child.on('error', (e: Error & { code?: string }) => {
      done({
        saved: false,
        error:
          e.code === 'ENOENT'
            ? 'yt-dlp is not installed (brew install yt-dlp / pip install yt-dlp)'
            : `yt-dlp failed to start: ${e.message}`
      })
    })
    child.on('close', (code) => {
      if (code === 0) {
        const file = pickFilepath(stdout)
        done({ saved: true, file: file ? (file.split('/').pop() ?? file) : undefined })
      } else {
        done({
          saved: false,
          error: errTail.slice(-3).join(' ').trim() || `yt-dlp exited with code ${code}`
        })
      }
    })
  })
}
