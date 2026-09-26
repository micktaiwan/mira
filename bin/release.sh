#!/usr/bin/env bash
# Publish a Mira release for macOS: bump the version, build the unsigned
# "release" app, zip it with its SHA-256, tag, push, and create the GitHub release
# that running Mira builds update themselves from (src/main/self-update.ts).
#
# Usage: bin/release.sh <major|minor|patch>
#
# Needs a clean master and `gh` logged in. It PUBLISHES (tag, push, public
# release): run it only when a release was asked for.
#
# The published app is ad-hoc signed, not with an Apple Developer certificate:
# see docs/releases.md for what that costs and how to sign your own build.
#
# It builds for the architecture it runs on. To add the other one, run
# bin/release-asset.sh on a Mac of that kind once this release exists.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=bin/release-app.sh
. bin/release-app.sh

bump="${1:-}"
case "$bump" in
  major | minor | patch) ;;
  *)
    echo "usage: bin/release.sh <major|minor|patch>" >&2
    exit 2
    ;;
esac

[ "$(git rev-parse --abbrev-ref HEAD)" = master ] || { echo "not on master" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "working tree not clean" >&2; exit 1; }
git pull --ff-only

npm run typecheck
npm test

prev="$(git describe --tags --abbrev=0 2>/dev/null || true)"
version="$(npm version "$bump" --no-git-tag-version | sed 's/^v//')"
arch="$(node -p process.arch)"
out="dist-release"

build_release_zip "$out" "$version"
zip_name="$RELEASE_ZIP"

changes="$(git log --no-merges --format='- %s' ${prev:+"$prev"..}HEAD)"
notes="$(
  cat <<NOTES
## Changes

$changes

## Install (macOS)

1. Download the zip for your Mac (\`-mac-arm64\` for Apple Silicon, \`-mac-x64\` for Intel),
   unzip it, move \`Mira.app\` to \`/Applications\`. This release was cut on $arch; the other
   architecture is uploaded from a Mac of that kind, so it may land a little later.
2. This build is not signed with an Apple Developer certificate, so macOS blocks it the first
   time. Run \`xattr -dr com.apple.quarantine /Applications/Mira.app\`, or open it once and allow
   it in System Settings → Privacy & Security.
3. From then on Mira updates itself: it downloads each new release, checks its SHA-256, and
   installs it when you quit.

What an unsigned build cannot do, and how to sign your own:
https://github.com/micktaiwan/mira/blob/master/docs/releases.md
NOTES
)"

git commit -am "release: v$version"
git tag "v$version"
git push origin master
git push origin "v$version"
gh release create "v$version" "$out/$zip_name" "$out/$zip_name.sha256" \
  --title "Mira $version" --notes "$notes"

echo "released v$version"
