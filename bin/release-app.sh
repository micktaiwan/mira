# Build, ad-hoc sign and zip the PUBLISHED macOS app, for the architecture this
# machine runs. Sourced by bin/release.sh (which publishes a new version) and by
# bin/release-asset.sh (which adds an architecture to a release already published
# from another Mac). Not executable on its own.
#
# build_release_zip <outputDir> <version> leaves the zip and its .sha256 in
# <outputDir> and sets RELEASE_ZIP to the zip's name.

build_release_zip() {
  local out="$1" version="$2"
  local arch
  arch="$(node -p process.arch)"
  rm -rf "$out"

  npm run build:addon
  npx electron-vite build
  node bin/release-build.cjs "$out"

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

  # The Electron zip ships the helper apps already signed; electron-builder renames
  # them and rewrites their Info.plist, which leaves that signature invalid. Signing
  # the bundle in one `--deep` pass then dies on it (`Mira.app: nested code is
  # modified or invalid`, x64, 2026-09-26), and passes if you simply run it twice,
  # which is what hid this until now. Re-sign the helpers first instead.
  local helper
  for helper in "$app"/Contents/Frameworks/*.app; do
    codesign --force --deep --sign - "$helper"
  done

  # Ad-hoc signature: required for the app to run at all on Apple Silicon, and what
  # the self-update's `codesign --verify` checks. Not a Developer ID: Gatekeeper
  # still blocks a downloaded copy until the user allows it once.
  codesign --force --deep --sign - "$app"
  codesign --verify --deep --strict "$app"

  RELEASE_ZIP="Mira-$version-mac-$arch.zip"
  ditto -c -k --sequesterRsrc --keepParent "$app" "$out/$RELEASE_ZIP"
  (cd "$out" && shasum -a 256 "$RELEASE_ZIP" >"$RELEASE_ZIP.sha256")
}
