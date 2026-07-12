import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'net'
import { existsSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { forwardRequest, forwardToRunningInstance } from './single-instance'

describe('forwardRequest', () => {
  it('builds an open-url command line for a queued url', () => {
    expect(JSON.parse(forwardRequest('file:///tmp/x.html'))).toEqual({
      command: 'open-url',
      params: { url: 'file:///tmp/x.html' }
    })
  })
})

describe('forwardToRunningInstance', () => {
  let server: Server | null = null
  const paths: string[] = []
  let n = 0

  function socketPath(): string {
    const p = join(tmpdir(), `mira-si-test-${process.pid}-${n++}.sock`)
    paths.push(p)
    return p
  }

  // Start a fake "running Mira": echoes one {"ok":true} line per request line.
  function startFakePrimary(path: string, received: string[]): Promise<void> {
    if (existsSync(path)) unlinkSync(path)
    server = createServer((conn) => {
      let buf = ''
      conn.on('data', (chunk) => {
        buf += chunk.toString()
        let idx: number
        while ((idx = buf.indexOf('\n')) >= 0) {
          received.push(buf.slice(0, idx))
          buf = buf.slice(idx + 1)
          conn.write(JSON.stringify({ ok: true }) + '\n')
        }
      })
    })
    return new Promise((resolve) => server!.listen(path, resolve))
  }

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
    for (const p of paths.splice(0)) {
      if (existsSync(p)) unlinkSync(p)
    }
  })

  it('returns false (we are primary) when no url is queued — without connecting', async () => {
    expect(await forwardToRunningInstance(socketPath(), [])).toBe(false)
  })

  it('returns false when nothing listens on the socket', async () => {
    // A path with no server: connect fails (ENOENT) → no primary → we boot.
    expect(await forwardToRunningInstance(socketPath(), ['https://example.com'], 500)).toBe(false)
  })

  it('forwards every queued url to a running instance and returns true', async () => {
    const path = socketPath()
    const received: string[] = []
    await startFakePrimary(path, received)

    const accepted = await forwardToRunningInstance(path, [
      'file:///tmp/a.html',
      'https://example.com'
    ])

    expect(accepted).toBe(true)
    expect(received.map((l) => JSON.parse(l))).toEqual([
      { command: 'open-url', params: { url: 'file:///tmp/a.html' } },
      { command: 'open-url', params: { url: 'https://example.com' } }
    ])
  })

  it('times out to false when a connected primary never replies', async () => {
    const path = socketPath()
    if (existsSync(path)) unlinkSync(path)
    // A server that accepts the connection but never answers.
    server = createServer(() => {})
    await new Promise<void>((resolve) => server!.listen(path, resolve))

    expect(await forwardToRunningInstance(path, ['https://example.com'], 150)).toBe(false)
  })
})
