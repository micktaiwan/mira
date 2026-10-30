// Replayable measurement of what Chromium does with a per-profile proxy, in the
// Electron version Mira ships (docs/socket.md § "Per-profile proxy").
//
//   npm run probe:proxy        (= electron scripts/proxy-probe/main.mjs)
//
// Localhost only, nothing leaves the machine: every DNS lookup except 127.0.0.1 is
// forced to fail locally (--host-resolver-rules), the "web server" and the "SOCKS
// servers" are local sockets, and the dead proxy is a loopback port nobody listens
// on. Runs headless (no window shown, no dock icon), in a throwaway userData dir,
// and exits by itself: 0 when every expectation holds, 1 otherwise, 2 on timeout.
// It is NOT Mira: it never touches Mira's profiles or its socket.
/* eslint-disable @typescript-eslint/explicit-function-return-type -- a plain JS dev script */
import { app, session, BrowserWindow } from 'electron'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Must match src/main/profile-proxy.ts (PROXY_BYPASS_RULES, BLACKHOLE_PROXY).
const BYPASS = '<-loopback>'
const BLACKHOLE = 'socks5://127.0.0.1:1'
/** Exactly what Mira hands session.setProxy (profile-proxy.ts proxyConfigFor). */
const mira = (proxyRules) => ({ mode: 'fixed_servers', proxyRules, proxyBypassRules: BYPASS })

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-proxy-probe-'))
app.setPath('userData', userData)
// The probe name resolves LOCALLY to the marker IP 127.0.0.2 (no network: an IP
// literal), so a local lookup of it is visible in the NetLog and in what a SOCKS
// server receives; every other name fails locally.
const PROBE_HOST = 'mira-probe.invalid'
const PROBE_LOCAL_IP = '127.0.0.2'
app.commandLine.appendSwitch(
  'host-resolver-rules',
  `MAP ${PROBE_HOST} ${PROBE_LOCAL_IP}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`
)
// Destroying each probe window must not quit the app before the probe ends.
app.on('window-all-closed', () => {})
setTimeout(() => {
  console.log('TIMEOUT')
  app.exit(2)
}, 30000)

function listen(server) {
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)))
}

async function closedPort() {
  const s = net.createServer()
  const port = await listen(s)
  await new Promise((r) => s.close(r))
  return port
}

// Fake SOCKS server: records each CONNECT request, then refuses it.
function fakeSocks(log) {
  return net.createServer((sock) => {
    let greeted = false
    sock.on('data', (buf) => {
      if (buf[0] === 4) {
        log.push({ version: 4, dstIp: `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}` })
        sock.end(Buffer.from([0, 0x5b, 0, 0, 0, 0, 0, 0]))
        return
      }
      if (!greeted) {
        greeted = true
        sock.write(Buffer.from([5, 0]))
        return
      }
      const atyp = buf[3]
      const host = atyp === 3 ? buf.slice(5, 5 + buf[4]).toString() : null
      log.push({ version: 5, atyp, host })
      sock.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0]))
    })
    sock.on('error', () => {})
  })
}

function load(partition, url) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({ show: false, webPreferences: { partition } })
    let done = false
    const finish = (r) => {
      if (done) return
      done = true
      win.destroy()
      resolve(r)
    }
    win.webContents.on('did-fail-load', (_e, code, desc, _url, isMain) => {
      if (isMain) finish({ ok: false, code, desc })
    })
    win.webContents.on('did-finish-load', () => finish({ ok: true }))
    win.loadURL(url).catch(() => {})
  })
}

/** HOST_RESOLVER_* NetLog events that name `host`: the session's local DNS
 * activity for it. */
/** Every host-resolver request of a session's NetLog for `host` (as rewritten by
 * the resolver rules), with the component that asked (its NetLog source type) and
 * the resolver task sequence Chromium created for it. */
function hostLookups(file, host) {
  const log = JSON.parse(fs.readFileSync(file, 'utf8'))
  const names = Object.fromEntries(
    Object.entries(log.constants.logEventTypes).map(([name, id]) => [id, name])
  )
  const sources = Object.fromEntries(
    Object.entries(log.constants.logSourceType).map(([name, id]) => [id, name])
  )
  return log.events
    .filter(
      (e) =>
        names[e.type] === 'HOST_RESOLVER_MANAGER_REQUEST' &&
        e.phase === 1 &&
        String(e.params?.host ?? '').includes(host)
    )
    .map((e) => {
      const seq = log.events.find(
        (x) =>
          x.source.id === e.source.id &&
          names[x.type] === 'HOST_RESOLVER_MANAGER_TASK_SEQUENCE_CREATED'
      )
      return { by: sources[e.source.type], tasks: seq?.params?.tasks ?? null }
    })
}
/** The lookups made on the CONNECTION path (to reach the site), as opposed to the
 * network quality estimator's bookkeeping lookup (see docs). */
const connectionLookups = (lookups) => lookups.filter((l) => l.by !== 'NETWORK_QUALITY_ESTIMATOR')

const checks = []
function expect(name, actual, wanted) {
  const pass = JSON.stringify(actual) === JSON.stringify(wanted)
  checks.push(pass)
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(actual)}`)
}

app.whenReady().then(async () => {
  app.dock?.hide()
  console.log(`electron ${process.versions.electron} / chromium ${process.versions.chrome}`)
  let hits = 0
  const web = http.createServer((_req, res) => {
    hits++
    res.end('hello')
  })
  const webPort = await listen(web)
  const target = `http://127.0.0.1:${webPort}/`
  const dead = await closedPort()

  // 1. Proxy down: pages fail, nothing goes direct.
  const a = session.fromPartition('probe-dead')
  await a.setProxy(mira(`socks5://127.0.0.1:${dead}`))
  expect('dead proxy: resolveProxy', await a.resolveProxy(target), `SOCKS5 127.0.0.1:${dead}`)
  expect(
    'dead proxy: local page',
    (await load('probe-dead', target)).desc,
    'ERR_PROXY_CONNECTION_FAILED'
  )
  expect(
    'dead proxy: https://www.linkedin.com/',
    (await load('probe-dead', 'https://www.linkedin.com/')).desc,
    'ERR_PROXY_CONNECTION_FAILED'
  )
  expect('dead proxy: requests that reached the server directly', hits, 0)

  // 2. Mira's black hole (fail-closed state) refuses everything the same way.
  const h = session.fromPartition('probe-blackhole')
  await h.setProxy(mira(BLACKHOLE))
  expect(
    'black hole: local page',
    (await load('probe-blackhole', target)).desc,
    'ERR_PROXY_CONNECTION_FAILED'
  )
  expect('black hole: requests that reached the server directly', hits, 0)

  // 3. Why <-loopback>: without it, loopback bypasses the (dead) proxy.
  const b = session.fromPartition('probe-implicit')
  await b.setProxy({ mode: 'fixed_servers', proxyRules: `socks5://127.0.0.1:${dead}` })
  expect('no <-loopback>: resolveProxy(loopback)', await b.resolveProxy(target), 'DIRECT')
  expect('no <-loopback>: local page loads', (await load('probe-implicit', target)).ok, true)
  expect('no <-loopback>: requests that reached the server directly', hits, 1)

  // 4. Isolation: other sessions, the default one included, are untouched.
  expect(
    'other partition',
    await session.fromPartition('probe-other').resolveProxy(target),
    'DIRECT'
  )
  expect('default session', await session.defaultSession.resolveProxy(target), 'DIRECT')

  // 5. DNS: socks5 hands the hostname to the proxy; socks4 resolves it locally.
  const log5 = []
  const s5 = fakeSocks(log5)
  const p5 = await listen(s5)
  const c = session.fromPartition('probe-socks5')
  await c.setProxy(mira(`socks5://127.0.0.1:${p5}`))
  // Count the session's own host-resolver activity for the name with its NetLog:
  // a local DNS lookup shows up as HOST_RESOLVER_* events carrying the host.
  const log5File = path.join(userData, 'socks5.netlog.json')
  await c.netLog.startLogging(log5File, { captureMode: 'everything' })
  await load('probe-socks5', 'http://mira-probe.invalid/')
  await c.netLog.stopLogging()
  expect('socks5: CONNECT seen by the proxy', log5, [
    { version: 5, atyp: 3, host: 'mira-probe.invalid' }
  ])
  const lookups5 = hostLookups(log5File, PROBE_LOCAL_IP)
  expect(
    'socks5: local lookups of the name on the connection path (NetLog)',
    connectionLookups(lookups5),
    []
  )
  // Reported, not asserted: Chromium's network quality estimator looks the page
  // host up once, after the request. Its task sequence has no system-resolver task
  // (compare socks4 below, whose connection lookup carries task 0); whether that
  // reaches the network cannot be settled from the NetLog (docs/socket.md).
  console.log(
    `INFO  socks5: other lookups of the name: ${JSON.stringify(lookups5.filter((l) => !connectionLookups([l]).length))}`
  )
  const log4 = []
  const s4 = fakeSocks(log4)
  const p4 = await listen(s4)
  const d = session.fromPartition('probe-socks4')
  await d.setProxy(mira(`socks4://127.0.0.1:${p4}`))
  const log4File = path.join(userData, 'socks4.netlog.json')
  await d.netLog.startLogging(log4File, { captureMode: 'everything' })
  const socks4Load = await load('probe-socks4', 'http://mira-probe.invalid/')
  await d.netLog.stopLogging()
  void socks4Load
  // socks4 resolves the name locally and hands the proxy an IP: the fake SOCKS4
  // server receives the locally resolved marker IP, not the name.
  expect('socks4: proxy received the LOCALLY resolved IP', log4, [
    { version: 4, dstIp: PROBE_LOCAL_IP }
  ])
  // Control for the socks5 counter: the same NetLog DOES see socks4's local lookup.
  const lookups4 = connectionLookups(hostLookups(log4File, PROBE_LOCAL_IP))
  expect(
    'socks4: local lookups of the name on the connection path (NetLog)',
    lookups4.length > 0,
    true
  )
  console.log(`INFO  socks4: connection-path lookups: ${JSON.stringify(lookups4)}`)

  // 6. Clearing goes direct.
  await a.setProxy({ mode: 'direct' })
  expect('after mode direct: resolveProxy', await a.resolveProxy(target), 'DIRECT')

  // 7. WebRTC policy round-trip (no ICE gathering: that would leave localhost).
  const w = new BrowserWindow({ show: false, webPreferences: { partition: 'probe-dead' } })
  w.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  expect('webrtc policy', w.webContents.getWebRTCIPHandlingPolicy(), 'disable_non_proxied_udp')
  w.destroy()

  web.close()
  s5.close()
  s4.close()
  const failed = checks.filter((p) => !p).length
  console.log(failed === 0 ? `ALL ${checks.length} CHECKS PASS` : `${failed} CHECK(S) FAILED`)
  if (process.env.MIRA_PROBE_KEEP) console.log(`kept ${userData}`)
  else fs.rmSync(userData, { recursive: true, force: true })
  app.exit(failed === 0 ? 0 : 1)
})
