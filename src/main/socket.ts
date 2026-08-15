// External control surface: a unix-domain socket that speaks one JSON request
// per line and drives the SAME command registry as the IPC transport. This is
// what makes Mira pilotable from a shell or an agent (see CLAUDE.md, "tout
// pilotable"). The MCP server, when it comes, is a thin wrapper over this.
//
// Protocol (mirrors Kova):
//   request:  {"command":"navigate","params":{"url":"example.com"}}\n
//   response: {"ok":true,"url":"https://example.com"}\n
//             {"ok":false,"error":"..."}\n

import { createServer, type Server, type Socket } from 'net'
import { existsSync, unlinkSync } from 'fs'
import type { CommandContext, CommandRegistry, CommandResult } from './commands'
import type { FocusFeed } from './focus-feed'

export type SocketResponse = CommandResult | { ok: false; error: string }

/** The only topic a client can subscribe to today (Kova names its stream the
 * same way, so a consumer written for one reads the other). */
export const FOCUS_TOPIC = 'focus'

/**
 * Recognize a `subscribe` request, BEFORE the registry sees it.
 *
 * Subscribing is not a command: a command answers once and is done, while this
 * turns the connection into a stream that outlives the request. Keeping it out
 * of the registry is what keeps every other command synchronous and pure.
 *
 * Returns the requested topics, or null when the line is an ordinary request.
 * Shape (Kova's, verbatim): {"cmd":"subscribe","events":["focus"]}.
 */
export function parseSubscribe(line: string): string[] | null {
  let msg: unknown
  try {
    msg = JSON.parse(line)
  } catch {
    return null
  }
  const { command, cmd, events } = (msg ?? {}) as {
    command?: unknown
    cmd?: unknown
    events?: unknown
  }
  const name = typeof command === 'string' ? command : cmd
  if (name !== 'subscribe') return null
  if (!Array.isArray(events)) return []
  return events.filter((e): e is string => typeof e === 'string')
}

/**
 * Parse one request line and dispatch it to the registry with the given context
 * (the target window). Pure (no socket I/O), so it is unit-testable. Returns the
 * response object to send back. For an async command (import-cookies) the value
 * is really a Promise at runtime; the socket loop awaits it (see consume).
 */
export function handleRequestLine(
  line: string,
  registry: CommandRegistry,
  ctx: CommandContext
): SocketResponse {
  let msg: unknown
  try {
    msg = JSON.parse(line)
  } catch {
    return { ok: false, error: 'invalid JSON' }
  }

  // `cmd` is a tolerated alias for `command` — Kova's sibling socket uses `cmd`,
  // so copy-pasted requests work across both. `command` stays the canonical form.
  const { command, cmd, params } = (msg ?? {}) as {
    command?: unknown
    cmd?: unknown
    params?: unknown
  }
  const name = typeof command === 'string' ? command : cmd
  if (typeof name !== 'string') {
    return { ok: false, error: 'missing "command" field' }
  }

  try {
    return registry.execute(name, params, ctx)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Handle on the running control socket. `server` always resolves to the LIVE
 * listener (it is swapped when the socket re-binds, see startCommandSocket);
 * `close` stops the vanish watchdog and the listener — call it on app quit,
 * BEFORE unlinking the socket file, or the watchdog would re-bind it. */
export interface CommandSocketHandle {
  readonly server: Server
  close: () => void
}

/**
 * Start the control socket. Removes any stale socket file first, then listens.
 * Each connection is line-buffered; a leftover buffer with no trailing newline
 * is still processed on connection end (forgiving for `printf ... | nc -U`).
 *
 * `makeContext` is called per request so each command binds to the currently
 * focused window at the moment it runs.
 *
 * A unix-socket listener is reached through its FILE: if something deletes
 * /tmp/mira.sock while Mira runs (a tmp cleaner, a stray rm), the server keeps
 * listening on the orphaned inode — lsof shows the socket held, but every client
 * fails with "no Mira socket" (seen live 2026-07-22). So a watchdog polls for
 * the file every `rebindCheckMs` and re-binds a fresh listener when it is gone;
 * connections already open ride the old inode and finish undisturbed.
 */
export function startCommandSocket(
  socketPath: string,
  registry: CommandRegistry,
  makeContext: () => CommandContext,
  rebindCheckMs = 5000,
  focusFeed?: FocusFeed
): CommandSocketHandle {
  const handleConnection = (conn: Socket): void => {
    let buffer = ''
    // Serialize responses through one chain so async commands (import-cookies)
    // still reply in request order.
    let chain: Promise<unknown> = Promise.resolve()
    // Non-null once this connection subscribed: the stream it must be detached
    // from when it hangs up, or the feed would write into a dead socket forever.
    let unsubscribe: (() => void) | null = null

    const consume = (line: string): void => {
      const trimmed = line.trim()
      if (trimmed === '') return
      const topics = parseSubscribe(trimmed)
      if (topics) {
        chain = chain.then(() => {
          if (!focusFeed || !topics.includes(FOCUS_TOPIC)) {
            conn.write(JSON.stringify({ ok: false, error: 'no such event stream' }) + '\n')
            return
          }
          // Reply with the situation as it stands, so a subscriber that starts
          // mid-session is immediately right instead of waiting for the next
          // change (which may be minutes away on a page being read).
          conn.write(JSON.stringify({ ok: true, data: { focus: focusFeed.current } }) + '\n')
          unsubscribe?.()
          unsubscribe = focusFeed.subscribe((focus) => {
            conn.write(JSON.stringify({ event: FOCUS_TOPIC, tab: focus }) + '\n')
          })
        })
        return
      }
      chain = chain.then(async () => {
        let response: SocketResponse
        try {
          response = await handleRequestLine(trimmed, registry, makeContext())
        } catch (error) {
          response = { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
        conn.write(JSON.stringify(response) + '\n')
      })
    }

    conn.on('data', (chunk) => {
      buffer += chunk.toString()
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        consume(buffer.slice(0, idx))
        buffer = buffer.slice(idx + 1)
      }
    })

    conn.on('end', () => {
      if (buffer.length > 0) consume(buffer)
    })

    // A subscriber holds its connection open for hours; every way it can end has
    // to release it. 'close' fires after 'end' and after 'error' alike, so it is
    // the one place that cannot be skipped.
    conn.on('close', () => {
      unsubscribe?.()
      unsubscribe = null
    })

    conn.on('error', () => {
      // A client that hangs up mid-request must not crash the main process.
    })
  }

  const listen = (): Server => {
    if (existsSync(socketPath)) unlinkSync(socketPath)
    const server = createServer(handleConnection)
    server.listen(socketPath)
    return server
  }

  let server = listen()

  const watchdog = setInterval(() => {
    if (existsSync(socketPath)) return
    console.warn(`[mira] control socket file vanished — re-binding ${socketPath}`)
    // close() only stops accepting; connections still open on the old inode
    // keep working until they hang up, then the old server is released.
    server.close()
    server = listen()
  }, rebindCheckMs)
  // The watchdog must never be what keeps the process alive.
  watchdog.unref()

  return {
    get server() {
      return server
    },
    close: () => {
      clearInterval(watchdog)
      server.close()
    }
  }
}

/** Best-effort removal of the socket file (call on app quit). */
export function cleanupSocket(socketPath: string): void {
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath)
  } catch {
    // ignore
  }
}
