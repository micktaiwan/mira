// The vanish watchdog of startCommandSocket: a unix-socket listener is reached
// through its FILE, so if /tmp/mira.sock is deleted while Mira runs, clients get
// "no Mira socket" while lsof still shows the listener alive (seen 2026-07-22).
// These tests drive a REAL unix socket on a temp path — the whole point is the
// bind/re-bind behavior, which has no pure core to extract.
import { describe, it, expect, afterEach } from 'vitest'
import { connect } from 'net'
import { existsSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startCommandSocket, type CommandSocketHandle } from './socket'
import type { CommandContext, CommandRegistry } from './commands'

// A stub registry: the watchdog never looks at commands, it only needs the
// round-trip to prove a client can reach the listener through the file.
const registry = {
  execute: () => ({ ok: true, pong: true })
} as unknown as CommandRegistry

const makeContext = (): CommandContext => ({}) as CommandContext

function request(socketPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = connect(socketPath)
    let buf = ''
    conn.on('connect', () => conn.write('{"command":"ping"}\n'))
    conn.on('data', (chunk) => {
      buf += chunk.toString()
      if (buf.includes('\n')) {
        conn.end()
        resolve(buf.trim())
      }
    })
    conn.on('error', reject)
  })
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('startCommandSocket vanish watchdog', () => {
  let handle: CommandSocketHandle | null = null
  let path = ''

  afterEach(() => {
    handle?.close()
    handle = null
    if (path && existsSync(path)) unlinkSync(path)
  })

  it('re-binds the socket file after it is deleted, and serves again', async () => {
    path = join(tmpdir(), `mira-rebind-${process.pid}-${Date.now()}.sock`)
    handle = startCommandSocket(path, registry, makeContext, 50)
    expect(JSON.parse(await request(path))).toEqual({ ok: true, pong: true })

    // Simulate the tmp cleaner / stray rm: the file goes, the inode stays held.
    unlinkSync(path)
    await waitFor(() => existsSync(path))

    expect(JSON.parse(await request(path))).toEqual({ ok: true, pong: true })
  })

  it('close() stops the watchdog: a deleted file is NOT re-bound after close', async () => {
    path = join(tmpdir(), `mira-close-${process.pid}-${Date.now()}.sock`)
    handle = startCommandSocket(path, registry, makeContext, 50)
    expect(JSON.parse(await request(path))).toEqual({ ok: true, pong: true })

    handle.close()
    handle = null
    if (existsSync(path)) unlinkSync(path)
    // Give a would-be watchdog several periods to (wrongly) resurrect the file.
    await new Promise((r) => setTimeout(r, 200))
    expect(existsSync(path)).toBe(false)
  })
})
