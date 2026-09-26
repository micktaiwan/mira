// Self-update for the published (unsigned) macOS build: the pure half.
//
// Mira has no paid Apple Developer account, so a published build is ad-hoc
// signed. Electron's standard updater (Squirrel.Mac) refuses that: it checks
// that the new bundle satisfies the running one's designated requirement, which
// for an ad-hoc signature is its own cdhash — no two builds ever match. So Mira
// updates itself: download the release zip, check its SHA-256 against the
// checksum published next to it, unpack and inspect the bundle, then swap it in
// once Mira has quit (a detached shell script does the swap, the running bundle
// cannot replace itself).
//
// Only a build made by bin/release.sh does any of this ("release" distribution,
// stamped into its package.json). A local build — signed with the owner's own
// certificate, the only kind that can carry Touch ID passkeys — is never replaced
// by a download.
//
// Everything here is pure; the network, disk and process work is in
// self-update-service.ts.

import { formatVersion, parseVersion, type Version } from './update-check'

/** How this build was made. `release` = bin/release.sh (unsigned, self-updating);
 * `local` = anything else (npm run build:mac, bin/build.sh, dev). */
export type Distribution = 'release' | 'local'

/** Read the distribution stamp bin/release.sh writes into the packaged
 * package.json (`miraDistribution`). Anything missing or unknown is `local`, so
 * a build never updates itself by accident. */
export function distributionOf(pkg: unknown): Distribution {
  if (
    pkg &&
    typeof pkg === 'object' &&
    (pkg as Record<string, unknown>).miraDistribution === 'release'
  ) {
    return 'release'
  }
  return 'local'
}

/** The zip bin/release.sh publishes for one version and architecture. */
export function assetName(version: Version, arch: string): string {
  return `Mira-${formatVersion(version)}-mac-${arch}.zip`
}

export interface ReleaseAsset {
  name: string
  browser_download_url: string
}

export interface ReleaseInfo {
  tag_name: string
  assets?: ReleaseAsset[]
}

export interface UpdateAssets {
  version: Version
  zipUrl: string
  sha256Url: string
}

/** Pick this machine's zip and its checksum out of a GitHub release. Both must be
 * there: a zip without a checksum is never installed. URLs are only accepted on
 * github.com / objects.githubusercontent.com over https. */
export function updateAssetsFor(
  release: ReleaseInfo,
  arch: string
): UpdateAssets | { error: string } {
  const version = parseVersion(release.tag_name ?? '')
  if (!version) return { error: `unparsable tag ${JSON.stringify(release.tag_name)}` }
  const zip = assetName(version, arch)
  const assets = release.assets ?? []
  const zipAsset = assets.find((a) => a.name === zip)
  const shaAsset = assets.find((a) => a.name === `${zip}.sha256`)
  if (!zipAsset) return { error: `release ${formatVersion(version)} has no ${zip}` }
  if (!shaAsset) return { error: `release ${formatVersion(version)} has no ${zip}.sha256` }
  for (const url of [zipAsset.browser_download_url, shaAsset.browser_download_url]) {
    if (!isTrustedDownload(url)) return { error: `refusing download from ${url}` }
  }
  return {
    version,
    zipUrl: zipAsset.browser_download_url,
    sha256Url: shaAsset.browser_download_url
  }
}

function isTrustedDownload(url: string): boolean {
  try {
    const u = new URL(url)
    return (
      u.protocol === 'https:' &&
      (u.hostname === 'github.com' || u.hostname.endsWith('.githubusercontent.com'))
    )
  } catch {
    return false
  }
}

/** The hash in a `.sha256` file (`shasum -a 256` format: `<hex>  <name>`), or null. */
export function parseSha256File(text: string): string | null {
  const first = text.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  return /^[0-9a-f]{64}$/.test(first) ? first : null
}

/** The `.app` bundle that contains the running executable
 * (`/Applications/Mira.app/Contents/MacOS/Mira` → `/Applications/Mira.app`), or
 * null when the executable is not inside a bundle (dev, `electron .`). */
export function bundlePathOf(execPath: string): string | null {
  const m = /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)
  return m ? m[1] : null
}

/** macOS runs a quarantined app downloaded from the web from a random read-only
 * copy (App Translocation) until the user moves it. Nothing can be replaced there:
 * the user has to move Mira to /Applications first. */
export function isTranslocated(bundlePath: string): boolean {
  return bundlePath.includes('/AppTranslocation/')
}

/** The swap, run by /bin/sh once Mira has quit. Arguments are passed as $1..$4,
 * never interpolated into the text, so no path can inject a command:
 *   $1 pid of the quitting Mira   $2 staged Mira.app
 *   $3 installed Mira.app         $4 "1" to relaunch it (in the background)
 * The old bundle is kept aside until the copy succeeds, and restored if it fails. */
export const INSTALL_SCRIPT = `
pid="$1"; staged="$2"; target="$3"; relaunch="$4"
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i+1)); [ "$i" -gt 600 ] && { echo "Mira did not quit, update skipped"; exit 1; }
  sleep 0.1
done
backup="$target.previous"
rm -rf "$backup"
if ! mv "$target" "$backup"; then echo "cannot move $target aside"; exit 1; fi
if ditto "$staged" "$target"; then
  rm -rf "$backup" "$staged"
  echo "installed $target"
else
  rm -rf "$target"; mv "$backup" "$target"
  echo "copy failed, previous Mira restored"
fi
[ "$relaunch" = "1" ] && open -g -a "$target"
exit 0
`

/** Whether to show the "this build is unsigned" notice at launch: release builds
 * only, until the user ticks "Don't show this again". */
export function shouldShowUnsignedNotice(distribution: Distribution, dismissed: boolean): boolean {
  return distribution === 'release' && !dismissed
}

export const SIGNING_DOC_URL =
  'https://github.com/micktaiwan/mira/blob/master/docs/releases.md#signing-mira-yourself'

/** The launch notice of an unsigned build. */
export const UNSIGNED_NOTICE = {
  message: 'This copy of Mira is not signed',
  detail:
    'It was built without an Apple Developer certificate. Most of Mira works the same: ' +
    'browsing, profiles, extensions, the command line and automatic updates.\n\n' +
    'What an unsigned build cannot do:\n' +
    '• Passkeys with Touch ID (WebAuthn). They need a keychain entitlement that only a ' +
    'signed build can carry.\n\n' +
    'What may be less smooth:\n' +
    '• After an update, macOS may ask again for camera, microphone, location or keychain ' +
    'access, because each unsigned build looks like a new app to it.\n\n' +
    'For a fully functional Mira, build it from source and sign it with your own Apple ' +
    'Development certificate.',
  buttons: ['OK', 'How to sign Mira'],
  checkbox: "Don't show this again"
} as const
