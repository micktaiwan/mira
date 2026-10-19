/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Headless smoke test of mira_kova.node, run with plain node:
//   node native/mira-kova/smoke.mjs
// Node-API is ABI-stable, so the addon built against Electron's headers loads in
// node too. It creates a pane WITHOUT view (no window, no AppKit run loop), runs
// one command in its shell, reads it back, then checks that bad ids and bad
// arguments are refused without throwing. No socket is served (ipcStart is not
// called), so nothing here touches /tmp.
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const kova = require(path.join(here, 'build', 'Release', 'mira_kova.node'))

const MARKER = 'mira-kova-smoke-ok'
let failures = 0
function check(cond, label) {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

// Bad input: never throws, always the "nothing" value.
let threw = null
try {
  check(kova.paneSetFrame(999999, 0, 0, 10, 10) === false, 'paneSetFrame(unknown id) is false')
  check(kova.paneSetHidden(999999, true) === false, 'paneSetHidden(unknown id) is false')
  check(kova.paneFocus(999999) === false, 'paneFocus(unknown id) is false')
  check(kova.panePaste(999999, 'x') === false, 'panePaste(unknown id) is false')
  check(kova.paneText(999999, 'x') === false, 'paneText(unknown id) is false')
  check(kova.paneIsAlive(999999) === false, 'paneIsAlive(unknown id) is false')
  check(kova.paneCopyText(999999) === null, 'paneCopyText(unknown id) is null')
  check(kova.paneFree(999999) === false, 'paneFree(unknown id) is false')
  check(kova.paneIsAlive('1') === false, 'paneIsAlive("1") is false')
  check(kova.paneCopyText() === null, 'paneCopyText() is null')
  check(kova.paneNew(-1, {}) === 0, 'paneNew(-1) is 0')
  check(kova.paneNew('x') === 0, 'paneNew("x") is 0')
  check(kova.paneNew(2147483000, {}) === 0, 'paneNew(unknown window) is 0')
  check(Array.isArray(kova.tickAll()), 'tickAll() with no pane is an array')
} catch (e) {
  threw = e
}
check(threw === null, `no call threw${threw ? ` (${threw.message})` : ''}`)

const id = kova.paneNew(0, { command: `echo ${MARKER}`, env: ['MIRA_KOVA_SMOKE=1', 'bogus'] })
check(id > 0, `paneNew(0, …) returned a pane id (${id})`)

let text = ''
if (id > 0) {
  check(kova.paneSetFrame(id, 0, 0, 100, 100) === false, 'paneSetFrame on a viewless pane is false')
  check(kova.paneSetHidden(id, true) === false, 'paneSetHidden on a viewless pane is false')
  check(kova.paneFocus(id) === false, 'paneFocus on a viewless pane is false')
  check(kova.paneSetHidden(id, 'yes') === false, 'paneSetHidden(id, non-boolean) is false')
  check(kova.paneText(id, 42) === false, 'paneText(id, non-string) is false')

  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    kova.tickAll()
    text = kova.paneCopyText(id) ?? ''
    // The typed command line contains the marker too; wait for the echoed line.
    if (text.split('\n').some((l) => l.trim() === MARKER)) break
    await new Promise((r) => setTimeout(r, 16))
  }
  const found = text.split('\n').some((l) => l.trim() === MARKER)
  check(found, `pane output contains the echoed "${MARKER}" line`)
  check(kova.paneIsAlive(id) === true, 'paneIsAlive is true while the shell runs')
  check(kova.paneFree(id) === true, 'paneFree(id) is true')
  check(kova.paneIsAlive(id) === false, 'paneIsAlive is false once freed')
  check(kova.paneFree(id) === false, 'paneFree(id) twice is false')
}
kova.shutdown()

if (failures === 0) {
  console.log(`PASS mira-kova smoke (${MARKER} read back)`)
} else {
  console.log(`FAIL mira-kova smoke: ${failures} check(s) failed; pane text was:\n${text}`)
}
process.exit(failures === 0 ? 0 : 1)
