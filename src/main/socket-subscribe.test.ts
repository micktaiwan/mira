// The push side of the socket: a client that subscribes must get the current
// focus at once, one line per change afterwards, and must be detached the moment
// it hangs up. Driven over a REAL unix socket — the subscription lives in the
// connection loop, not in a pure function, so there is nothing else to test.
import { describe, it, expect, afterEach } from 'vitest'
import { connect, type Socket } from 'net'
import { existsSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startCommandSocket, parseSubscribe, type CommandSocketHandle } from './socket'
import { FocusFeed, type TabFocus } from './focus-feed'
import type { CommandContext, CommandRegistry } from './commands'

const registry = {
  execute: () => ({ ok: true, pong: true })
} as unknown as CommandRegistry
const makeContext = (): CommandContext => ({}) as CommandContext

const focus = (over: Partial<TabFocus> = {}): TabFocus => ({
  windowId: 'w1',
  profileId: 'default',
  profileLabel: 'pro: lempire',
  tabId: 't1',
  url: 'https://app.trykondo.com/',
  title: 'Kondo',
  folderId: null,
  folderTitle: null,
  ...over
})

let handle: CommandSocketHandle | null = null
let client: Socket | null = null
let path = ''

afterEach(() => {
  client?.destroy()
  client = null
  handle?.close()
  handle = null
  if (path && existsSync(path)) unlinkSync(path)
})

/** Open a subscribed client and collect the lines it receives. */
function subscribed(
  feed: FocusFeed,
  request = '{"cmd":"subscribe","events":["focus"]}\n'
): { lines: unknown[]; ready: Promise<void> } {
  path = join(tmpdir(), `mira-sub-${process.pid}-${Math.random().toString(36).slice(2)}.sock`)
  handle = startCommandSocket(path, registry, makeContext, 60_000, feed)
  const lines: unknown[] = []
  let buf = ''
  const ready = new Promise<void>((resolve, reject) => {
    client = connect(path)
    client.on('connect', () => client?.write(request))
    client.on('data', (chunk) => {
      buf += chunk.toString()
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        lines.push(JSON.parse(buf.slice(0, idx)))
        buf = buf.slice(idx + 1)
        resolve()
      }
    })
    client.on('error', reject)
  })
  return { lines, ready }
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('parseSubscribe', () => {
  it('accepts both spellings of the field, like every other request', () => {
    expect(parseSubscribe('{"cmd":"subscribe","events":["focus"]}')).toEqual(['focus'])
    expect(parseSubscribe('{"command":"subscribe","events":["focus"]}')).toEqual(['focus'])
  })

  it('leaves ordinary requests to the registry', () => {
    expect(parseSubscribe('{"command":"list-tabs"}')).toBeNull()
    expect(parseSubscribe('not json')).toBeNull()
  })

  it('reports no topic rather than throwing on a malformed events field', () => {
    expect(parseSubscribe('{"cmd":"subscribe"}')).toEqual([])
    expect(parseSubscribe('{"cmd":"subscribe","events":[1,"focus"]}')).toEqual(['focus'])
  })
})

describe('subscribe over the socket', () => {
  it('answers with the focus as it stands, then streams every change', async () => {
    const feed = new FocusFeed()
    feed.publish(focus())
    const { lines, ready } = subscribed(feed)
    await ready
    expect(lines[0]).toEqual({ ok: true, data: { focus: focus() } })

    feed.publish(focus({ tabId: 't2', url: 'https://mail.google.com/', title: 'Mail' }))
    feed.publish(null)
    await waitFor(() => lines.length === 3)

    expect(lines[1]).toEqual({
      event: 'focus',
      tab: focus({ tabId: 't2', url: 'https://mail.google.com/', title: 'Mail' })
    })
    expect(lines[2]).toEqual({ event: 'focus', tab: null })
  })

  it('says so when the topic is unknown, instead of holding a mute socket', async () => {
    const feed = new FocusFeed()
    const { lines, ready } = subscribed(feed, '{"cmd":"subscribe","events":["weather"]}\n')
    await ready
    expect(lines[0]).toEqual({ ok: false, error: 'no such event stream' })
    expect(feed.subscriberCount).toBe(0)
  })

  it('still serves ordinary commands on a subscribed connection', async () => {
    const feed = new FocusFeed()
    const { lines, ready } = subscribed(feed)
    await ready
    client?.write('{"command":"ping"}\n')
    await waitFor(() => lines.length === 2)
    expect(lines[1]).toEqual({ ok: true, pong: true })
  })

  it('detaches the subscriber when the client hangs up', async () => {
    const feed = new FocusFeed()
    const { ready } = subscribed(feed)
    await ready
    await waitFor(() => feed.subscriberCount === 1)
    client?.destroy()
    await waitFor(() => feed.subscriberCount === 0)
  })
})
