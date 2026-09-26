# Releases and self-update (macOS)

Mira publishes an **unsigned** macOS build on GitHub Releases, and that build updates itself.
There is no paid Apple Developer account behind Mira, so the published app is ad-hoc signed; this
page says what that costs and how to sign your own build.

## Two kinds of build

|                              | Published build (`bin/release.sh`)                         | Local build (`bin/build.sh`, `npm run build:mac`)         |
| ---------------------------- | ---------------------------------------------------------- | --------------------------------------------------------- |
| Signature                    | ad-hoc                                                     | your Apple Development certificate + provisioning profile |
| Runs on                      | any Mac of that zip's architecture, after allowing it once | only the Macs listed in your profile                      |
| Touch ID passkeys (WebAuthn) | no                                                         | yes                                                       |
| Updates itself               | yes                                                        | no, rebuild from source                                   |
| Unsigned notice at launch    | yes, until dismissed                                       | no                                                        |

The published build carries `"miraDistribution": "release"` in its packaged `package.json`
(`bin/release-build.cjs`). That stamp alone turns on the notice and the self-update
(`distributionOf` in `src/main/self-update.ts`); a local build is never replaced by a download.

## Publishing a release

```bash
bin/release.sh patch   # or minor / major
```

On a clean `master` with `gh` logged in, it: runs the typecheck and the tests, bumps the version
in `package.json`, builds the native addons and the app, builds the release app with
`bin/release-build.cjs` (electron-builder with the owner-only signing stripped out), ad-hoc signs
it (`codesign --sign -`), zips it with `ditto`, writes `Mira-<version>-mac-<arch>.zip.sha256`,
commits `release: v<version>`, tags, pushes, and creates the GitHub release with both files and
install notes. It publishes: run it only when a release is wanted.

Before signing, it refuses to go on if `app.asar` holds anything besides `out/`, `resources/`,
`node_modules/` and `package.json`. `electron-builder.yml`'s `files` is an allow-list for the same
reason: the 1.1.0 zip, built when it was still a deny-list, carried every file lying at the repo
root (older builds in `dist/`, local notes, scratch scripts) and its assets were deleted.

It builds for the architecture it runs on, so a fresh release carries one zip.

## Adding the other architecture

The native addons (`native/mira-*`) are compiled for the host by node-gyp, so an Apple Silicon Mac
cannot produce the Intel app, and the other way round. A release therefore gets its second zip
from a second machine:

```bash
git checkout v1.1.1        # the tag the release was cut from
bin/release-asset.sh       # or bin/release-asset.sh v1.1.1
```

On a Mac of the missing kind, it runs the typecheck and the tests, builds and ad-hoc signs the same
release app, and uploads `Mira-<version>-mac-<arch>.zip` and its `.sha256` to the existing release.
It creates nothing and bumps nothing, refuses a tree that is not clean or not checked out at the
tag, checks `package.json` against the tag (the self-update compares the downloaded bundle's
version), and exits quietly if that architecture is already there.

Until it has run, a Mira of that architecture finds no asset to update itself with: `prepareUpdate`
looks for `Mira-<version>-mac-<process.arch>.zip` and a missing one reads as "no update", with
nothing said.

## How the self-update works

1. The daily update check (`src/main/update-service.ts`) asks GitHub for the latest release. On a
   published build, a newer version is not just announced: it is downloaded.
2. `prepareUpdate` (`src/main/self-update-service.ts`) picks `Mira-<version>-mac-<arch>.zip` and its
   `.sha256` from the release (downloads only from GitHub hosts, over https), checks the SHA-256
   of what it downloaded, unpacks it with `ditto`, checks the bundle id, the bundle version and the
   signature (`codesign --verify --deep --strict`), and keeps it in `<userData>/updates/staged/`.
3. A notification says the version is ready. Clicking it restarts Mira now.
4. When Mira quits, a detached shell script (`INSTALL_SCRIPT`) waits for the process to exit, moves
   the installed `Mira.app` aside, copies the staged one in, and restores the old one if the copy
   fails. The log is `<userData>/updates/install.log`.

Why not Electron's standard updater: Squirrel.Mac only accepts a new bundle that satisfies the
running one's designated requirement, and an ad-hoc signature's requirement is its own hash, so no
two ad-hoc builds ever match.

Limits:

- Mira must run from a writable folder (normally `/Applications`). A copy started straight from
  the download is run by macOS from a read-only temporary location (App Translocation) and cannot
  replace itself: the update fails with a message saying to move Mira first.
- The daily check announces each version once. If its download fails, **Check for Updates** in the
  app menu retries it.
- One architecture at a time: a release only holds what its publishing machine built, until
  `bin/release-asset.sh` adds the other (above).

## What an unsigned build cannot do

- **Touch ID passkeys (WebAuthn).** Mira stores platform credentials under a keychain access group
  (`src/main/webauthn.ts`). That entitlement is restricted by macOS and only honored on an app whose
  embedded provisioning profile authorizes it.
- **Less smooth permissions.** Each ad-hoc build has a different signature, so macOS may treat an
  update as a new app and ask again for camera, microphone, location or keychain access.
- **First launch.** macOS blocks a downloaded unsigned app once: allow it in System Settings →
  Privacy & Security, or run `xattr -dr com.apple.quarantine /Applications/Mira.app`.

## Signing Mira yourself

For a fully functional Mira, build it from source with your own Apple Development certificate. A
free Apple account is enough.

1. In Xcode, sign in with your Apple ID (Settings → Accounts) and create an "Apple Development"
   certificate. Note your team id (`security find-identity -v -p codesigning` shows the
   certificate; `codesign -dvvv` on any app you signed shows `TeamIdentifier`).
2. In `electron-builder.yml`, set `appId` to a bundle id you own, `mac.identity` to your
   certificate's name, and replace the team id in `build/entitlements.mac.plist`
   (`keychain-access-groups`, `com.apple.application-identifier`,
   `com.apple.developer.team-identifier`) and in `WEBAUTHN_KEYCHAIN_GROUP` (`src/main/webauthn.ts`).
3. Mint a provisioning profile for that bundle id that authorizes the keychain group, and save it
   as `build/embedded.provisionprofile`. A free team's profile expires after 7 days: re-mint it and
   rebuild weekly. The recipe (a throwaway Xcode project that requests the capability) is in
   `.claude/rules/packaging.md`.
4. `npm install`, then `bin/build.sh`: it builds, installs to `/Applications/Mira.app` and relaunches.

A build made this way is a local build: it does not update itself. Pull and rebuild to update.
