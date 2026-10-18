# Build, sign, notarize and zip the PUBLISHED macOS app for one architecture.
# Sourced by bin/release.sh. Not executable on its own.
#
# Needs MIRA_RELEASE_IDENTITY (the Developer ID Application certificate, without
# its prefix) and MIRA_NOTARY_PROFILE (a `notarytool store-credentials` keychain
# profile); bin/release.sh checks both before it bumps anything.
#
# build_release_zip <outputDir> <version> <arch> leaves the zip and its .sha256 in
# <outputDir> and sets RELEASE_ZIP to the zip's name. <arch> is arm64 or x64, and
# need not be this Mac's: the native addons are compiled for it by node-gyp
# (`--arch`, package.json build:addon:*) and electron-builder packs the Electron
# of that architecture. Verified 2026-10-06 on an arm64 Mac: the x64 app holds
# only x86_64 Mach-O files, passes `codesign --verify --deep --strict`, and its
# three addons load in the x64 Electron under Rosetta.
#
# Side effect: native/*/build/Release ends up holding the LAST architecture built.
# bin/release.sh builds this Mac's architecture last, so `npm run dev` keeps
# loading addons it can run.
#
# Build, sign and zip steps first contributed in PR #2.

# Download Electron's zip for one architecture into a local cache, checked against
# Electron's own SHASUMS256.txt, and point release-build.cjs at it
# (MIRA_ELECTRON_DIST). electron-builder's built-in download once stalled for its
# full 10-minute timeout on the x64 zip, while curl fetched the same file in 6 s
# (2026-10-06).
fetch_electron_zip() {
  local arch="$1"
  local version cache zip
  version="$(node -p "require('electron/package.json').version")"
  cache="${MIRA_ELECTRON_CACHE:-$HOME/Library/Caches/mira-release/electron}/$version"
  zip="electron-v$version-darwin-$arch.zip"
  mkdir -p "$cache"
  local base="https://github.com/electron/electron/releases/download/v$version"
  [ -s "$cache/SHASUMS256.txt" ] ||
    curl -fsSL --retry 3 --max-time 120 -o "$cache/SHASUMS256.txt" "$base/SHASUMS256.txt"
  if ! (cd "$cache" && grep -F " *$zip" SHASUMS256.txt | shasum -a 256 -c --status 2>/dev/null); then
    curl -fsSL --retry 3 --max-time 900 -o "$cache/$zip" "$base/$zip"
    (cd "$cache" && grep -F " *$zip" SHASUMS256.txt | shasum -a 256 -c --status) || {
      echo "checksum mismatch for $zip" >&2
      return 1
    }
  fi
  export MIRA_ELECTRON_DIST="$cache"
}

# Send the signed app to Apple's notary service, wait for its verdict, and staple
# the ticket into the bundle, so Gatekeeper accepts a downloaded copy even
# offline. notarytool's exit code does not say whether Apple accepted the app:
# read the status from its JSON, and print Apple's log when it is not Accepted.
notarize_app() {
  local out="$1" app="$2"
  local zip="$out/notarize.zip" result id status
  ditto -c -k --sequesterRsrc --keepParent "$app" "$zip"
  result="$(xcrun notarytool submit "$zip" --keychain-profile "$MIRA_NOTARY_PROFILE" \
    --wait --timeout 1h --output-format json)" || true
  rm -f "$zip"
  id="$(node -p 'JSON.parse(process.argv[1]).id ?? ""' "$result")"
  status="$(node -p 'JSON.parse(process.argv[1]).status ?? ""' "$result")"
  echo "notarization $id: $status"
  if [ "$status" != Accepted ]; then
    [ -n "$id" ] && xcrun notarytool log "$id" --keychain-profile "$MIRA_NOTARY_PROFILE" >&2
    echo "refusing to publish, Apple did not accept $app: $result" >&2
    return 1
  fi
  xcrun stapler staple "$app"
  xcrun stapler validate "$app"
  spctl --assess --type execute -vv "$app"
}

build_release_zip() {
  local out="$1" version="$2" arch="$3"
  case "$arch" in
    arm64 | x64) ;;
    *)
      echo "unsupported arch: $arch" >&2
      return 1
      ;;
  esac
  rm -rf "$out"

  fetch_electron_zip "$arch"
  MIRA_ARCH="$arch" npm run build:addon
  npx electron-vite build
  MIRA_ARCH="$arch" node bin/release-build.cjs "$out"

  local app
  app="$(find "$out" -maxdepth 2 -name Mira.app -type d | head -1)"
  [ -n "$app" ] || {
    echo "no Mira.app under $out" >&2
    return 1
  }

  # Nothing but the app goes public. The 1.1.0 zip carried private files lying at
  # the repo root (electron-builder's `files` was a deny-list then): refuse any
  # asar entry outside the allow-list, whatever electron-builder.yml says.
  node -e '
const asar = require("@electron/asar")
const allowed = /^\/(out|resources|node_modules)(\/|$)|^\/package\.json$/
const leaked = asar.listPackage(process.argv[1]).filter((f) => !allowed.test(f))
const dirs = new Set(leaked.map((f) => f.split("/").slice(0, 2).join("/")))
if (dirs.size) { console.error("refusing to publish, unexpected files in app.asar:\n" + [...dirs].join("\n")); process.exit(1) }
' "$app/Contents/Resources/app.asar"

  # Every Mach-O must be of the target architecture: a stale addon of the other
  # one would make the app crash at launch on the Macs this zip is for.
  local want wrong
  [ "$arch" = x64 ] && want=x86_64 || want=arm64
  wrong="$(find "$app" -type f -print0 | xargs -0 file | grep 'Mach-O' | grep -v "$want" || true)"
  [ -z "$wrong" ] || {
    echo "refusing to publish, Mach-O files not built for $want:" >&2
    echo "$wrong" >&2
    return 1
  }

  # electron-builder signed every Mach-O with the Developer ID certificate and the
  # hardened runtime (bin/release-build.cjs). Check it did, before Apple sees it.
  codesign --verify --deep --strict "$app"
  local sig
  sig="$(codesign -dv --verbose=4 "$app" 2>&1)"
  grep -q '^Authority=Developer ID Application:' <<<"$sig" || {
    echo "refusing to publish, $app is not signed with a Developer ID certificate:" >&2
    echo "$sig" >&2
    return 1
  }
  grep -q '^CodeDirectory .*flags=.*(runtime)' <<<"$sig" || {
    echo "refusing to publish, $app is not signed with the hardened runtime" >&2
    return 1
  }

  # The Developer ID profile is what makes the keychain group valid at runtime
  # (Touch ID passkeys): without it in the bundle, the entitlement would not
  # validate and WebAuthn would hang.
  [ -f "$app/Contents/embedded.provisionprofile" ] || {
    echo "refusing to publish, $app embeds no provisioning profile" >&2
    return 1
  }
  codesign -d --entitlements - --xml "$app" 2>/dev/null | grep -q keychain-access-groups || {
    echo "refusing to publish, $app is not signed with the keychain-access-groups entitlement" >&2
    return 1
  }

  notarize_app "$out" "$app"

  RELEASE_ZIP="Mira-$version-mac-$arch.zip"
  ditto -c -k --sequesterRsrc --keepParent "$app" "$out/$RELEASE_ZIP"
  (cd "$out" && shasum -a 256 "$RELEASE_ZIP" >"$RELEASE_ZIP.sha256")
}
