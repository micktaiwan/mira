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

export type SocketResponse = CommandResult | { ok: false; error: string }

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
  rebindCheckMs = 5000
): CommandSocketHandle {
  const handleConnection = (conn: Socket): void => {
    let buffer = ''
    // Serialize responses through one chain so async commands (import-cookies)
    // still reply in request order.
    let chain: Promise<unknown> = Promise.resolve()

    const consume = (line: string): void => {
      const trimmed = line.trim()
      if (trimmed === '') return
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
