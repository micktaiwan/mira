#!/usr/bin/env node
// Build the PUBLISHED macOS app: the one bin/release.sh zips and uploads.
//
// It is electron-builder.yml with the owner-only signing stripped out. The local
// build is signed with a personal Apple Development certificate and a provisioning
// profile that lists ONE Mac and expires after 7 days (see the mac section of
// electron-builder.yml) — a binary signed that way cannot be handed to anyone. So
// here: no identity (electron-builder skips signing, release.sh ad-hoc signs after),
// no profile, no entitlements (no hardened runtime, so none are needed), an
// unpacked `dir` target, and a `miraDistribution: release` stamp in the packaged
// package.json, which is what turns on the unsigned notice and the self-update
// (src/main/self-update.ts).
//
// Usage: node bin/release-build.cjs <outputDir>
/* eslint-disable @typescript-eslint/no-require-imports -- plain CommonJS, run by node without a build */
const { readFileSync } = require('node:fs')
const yaml = require('js-yaml')
const { build, Platform, Arch } = require('electron-builder')

const output = process.argv[2]
if (!output) {
  console.error('usage: release-build.cjs <outputDir>')
  process.exit(2)
}

const config = yaml.load(readFileSync('electron-builder.yml', 'utf8'))
config.directories = { ...config.directories, output }
config.extraMetadata = { ...config.extraMetadata, miraDistribution: 'release' }
const mac = { ...config.mac, identity: null, target: 'dir', hardenedRuntime: false }
delete mac.type
delete mac.provisioningProfile
delete mac.entitlements
delete mac.entitlementsInherit
config.mac = mac
delete config.publish

const arch = Arch[process.arch]
if (arch === undefined) {
  console.error(`unsupported arch ${process.arch}`)
  process.exit(2)
}

build({ targets: Platform.MAC.createTarget('dir', arch), config, publish: 'never' })
  .then((paths) => console.log(paths.join('\n')))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
