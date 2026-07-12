// Single-instance-over-socket for the default-browser handoff.
//
// The problem: macOS only routes `open foo.html` / a double-click / a clicked
// link to the PACKAGED bundle — never to `npm run dev`. So while Mira runs in
// dev, a plain `open` would launch a SECOND Mira (the packaged one) next to it.
//
// The fix: dev and build listen on the SAME control socket (default
// /tmp/mira.sock). Before the freshly-launched build creates any window, it
// probes that socket. If another Mira answers (the dev instance), it forwards
// the queued url(s) via the existing `open-url` command and quits — the page
// opens in the already-running Mira, no second window. If nobody answers, it is
// the primary and boots normally.
//
// This lives here (not in socket.ts) because it is the CLIENT side of the
// socket, only used at boot; socket.ts is the server. Pure request-building is
// split out so it is unit-testable without any I/O.

import { connect } from 'net'

/** The socket line that hands one queued url to a running Mira. */
export function forwardRequest(url: string): string {
  return JSON.stringify({ command: 'open-url', params: { url } })
}

/**
 * Try to hand the queued open url(s) to a Mira already listening on `socketPath`.
 * Resolves `true` when a running instance accepted them (the caller should quit),
 * `false` when none is reachable (the caller is the primary and must boot). Never
 * rejects: a missing/stale socket, a connection error, or a timeout all mean "no
 * primary" → `false`.
 */
export function forwardToRunningInstance(
  socketPath: string,
  urls: string[],
  timeoutMs = 2000
): Promise<boolean> {
  if (urls.length === 0) return Promise.resolve(false)

  return new Promise((resolve) => {
    const conn = connect(socketPath)
    let settled = false
    const finish = (accepted: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      conn.destroy()
      resolve(accepted)
    }

    // A hung primary (connected but never replies) must not block the boot.
    const timer = setTimeout(() => finish(false), timeoutMs)

    // ECONNREFUSED (stale socket file, nobody listening) / ENOENT (no file) →
    // no primary alive → we are it.
    conn.on('error', () => finish(false))

    conn.on('connect', () => {
      for (const url of urls) conn.write(forwardRequest(url) + '\n')
    })

    // Wait for one response line per url, then we know they all landed and quit.
    let buffer = ''
    let replies = 0
    conn.on('data', (chunk) => {
      buffer += chunk.toString()
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        buffer = buffer.slice(idx + 1)
        replies += 1
        if (replies >= urls.length) finish(true)
      }
    })
  })
}
