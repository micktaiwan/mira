// External control surface: a unix-domain socket that speaks one JSON request
// per line and drives the SAME command registry as the IPC transport. This is
// what makes Mira pilotable from a shell or an agent (see CLAUDE.md, "tout
// pilotable"). The MCP server, when it comes, is a thin wrapper over this.
//
// Protocol (mirrors Kova):
//   request:  {"command":"navigate","params":{"url":"example.com"}}\n
//   response: {"ok":true,"url":"https://example.com"}\n
//             {"ok":false,"error":"..."}\n

import { createServer, type Server } from 'net'
import { existsSync, unlinkSync } from 'fs'
import type { CommandContext, CommandRegistry, CommandResult } from './commands'

export type SocketResponse = CommandResult | { ok: false; error: string }

/**
 * Parse one request line and dispatch it to the registry with the given context
 * (the target window). Pure (no socket I/O), so it is unit-testable. Returns the
 * response object to send back.
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

  const { command, params } = (msg ?? {}) as { command?: unknown; params?: unknown }
  if (typeof command !== 'string') {
    return { ok: false, error: 'missing "command" field' }
  }

  try {
    return registry.execute(command, params, ctx)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Start the control socket. Removes any stale socket file first, then listens.
 * Each connection is line-buffered; a leftover buffer with no trailing newline
 * is still processed on connection end (forgiving for `printf ... | nc -U`).
 *
 * `makeContext` is called per request so each command binds to the currently
 * focused window at the moment it runs.
 */
export function startCommandSocket(
  socketPath: string,
  registry: CommandRegistry,
  makeContext: () => CommandContext
): Server {
  if (existsSync(socketPath)) unlinkSync(socketPath)

  const server = createServer((conn) => {
    let buffer = ''

    const consume = (line: string): void => {
      const trimmed = line.trim()
      if (trimmed === '') return
      const response = handleRequestLine(trimmed, registry, makeContext())
      conn.write(JSON.stringify(response) + '\n')
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
  })

  server.listen(socketPath)
  return server
}

/** Best-effort removal of the socket file (call on app quit). */
export function cleanupSocket(socketPath: string): void {
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath)
  } catch {
    // ignore
  }
}
