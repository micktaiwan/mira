/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Optional build of the Kova addon (mira_kova.node).
//
// libkova.a is not part of this repo: it is built from the Kova repo. When it is
// missing, or built for another arch than the one being packaged, this script
// skips the addon and exits 0, so `npm run build:addon` and the release keep
// working; Mira then sees no mira_kova.node and falls back at runtime. In both
// skip cases build/Release/ is left existing but empty of mira_kova.node, so the
// electron-builder extraResources entry (a filter on that dir) ships nothing
// rather than a stale binary.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { kovaLibPath } = require('./lib-path.cjs')

const here = path.dirname(fileURLToPath(import.meta.url))
const releaseDir = path.join(here, 'build', 'Release')
const nodeFile = path.join(releaseDir, 'mira_kova.node')

function skip(reason) {
  mkdirSync(releaseDir, { recursive: true })
  rmSync(nodeFile, { force: true })
  console.log(`[mira-kova] ${reason}: skipping, the AI pane keeps claude -p`)
  process.exit(0)
}

const arch = process.env.MIRA_ARCH || process.arch
const lipoArch = arch === 'x64' ? 'x86_64' : arch
const lib = kovaLibPath()

if (!existsSync(lib)) skip(`libkova.a not found (${lib})`)

let libArchs
try {
  libArchs = execFileSync('lipo', ['-archs', lib], { encoding: 'utf8' }).trim().split(/\s+/)
} catch (e) {
  skip(`cannot read the arch of ${lib} (${e.message.split('\n')[0]})`)
}
if (!libArchs.includes(lipoArch)) {
  skip(`libkova.a is ${libArchs.join(',')}, not ${lipoArch} (${lib})`)
}

const electronVersion = require('electron/package.json').version
const nodeGyp = path.resolve(here, '..', '..', 'node_modules', '.bin', 'node-gyp')
const result = spawnSync(
  existsSync(nodeGyp) ? nodeGyp : 'node-gyp',
  [
    'rebuild',
    `--target=${electronVersion}`,
    '--dist-url=https://electronjs.org/headers',
    `--arch=${arch}`
  ],
  { cwd: here, stdio: 'inherit', env: { ...process.env, KOVA_LIB: lib } }
)
if (result.error) {
  console.error(`[mira-kova] node-gyp failed to start: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
