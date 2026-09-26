#!/usr/bin/env bash
# Add THIS machine's architecture to a release published from another Mac.
#
# bin/release.sh builds for the architecture it runs on, so a release cut on an
# Apple Silicon Mac carries only Mira-<version>-mac-arm64.zip. An Intel Mira then
# finds nothing to update itself with: prepareUpdate picks
# Mira-<version>-mac-<process.arch>.zip (src/main/self-update-service.ts), and the
# missing asset reads as "no update", quietly, forever. Cross-building the other
# architecture is not an option either: the native addons (native/mira-*) are
# compiled for the host by node-gyp, so each build has to happen on its own kind
# of Mac.
#
# So: publish from one Mac with bin/release.sh, then run this on a Mac of the
# other kind to upload that build to the same release.
#
# Usage: bin/release-asset.sh [vX.Y.Z]   (default: the most recent tag)
#
# Needs `gh` logged in, a clean tree, and HEAD checked out AT the release's tag,
# so the uploaded app is built from exactly the published commit. It uploads to
# an existing release and never creates, tags or bumps anything.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=bin/release-app.sh
. bin/release-app.sh

git fetch --tags --quiet
tag="${1:-$(git describe --tags --abbrev=0)}"
version="${tag#v}"
arch="$(node -p process.arch)"

[ -z "$(git status --porcelain)" ] || {
  echo "working tree not clean" >&2
  exit 1
}
[ "$(git rev-parse HEAD)" = "$(git rev-parse "$tag^{commit}" 2>/dev/null)" ] || {
  echo "HEAD is not $tag, run: git checkout $tag" >&2
  exit 1
}
# The self-update checks the downloaded bundle's version against the release's:
# a package.json out of step with the tag would build an app it then rejects.
[ "$(node -p 'require("./package.json").version')" = "$version" ] || {
  echo "package.json is not $version" >&2
  exit 1
}

assets="$(gh release view "$tag" --json assets --jq '.assets[].name')" || {
  echo "no release $tag" >&2
  exit 1
}
zip_name="Mira-$version-mac-$arch.zip"
if grep -qxF "$zip_name" <<<"$assets"; then
  echo "$tag already carries $zip_name"
  exit 0
fi

npm run typecheck
npm test

out="dist-release"
build_release_zip "$out" "$version"
gh release upload "$tag" "$out/$RELEASE_ZIP" "$out/$RELEASE_ZIP.sha256"

echo "uploaded $RELEASE_ZIP to $tag"
