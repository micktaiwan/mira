#!/usr/bin/env bash
# Build Mira and refresh the installed app.
#
# /Applications/Mira.app is a REAL COPY of dist/mac-arm64/Mira.app, not a symlink.
# It used to be a symlink, and that broke macOS app identity: the kernel records the
# exec path as /Applications/Mira.app/Contents/MacOS/Mira, while LaunchServices only
# ever registers the resolved dist path (lsregister -f on the symlink registers
# nothing). Privacy subsystems that map a running process back to a bundle then find
# nothing, so the app falls through to the default deny rule. The visible symptom was
# ERR_ADDRESS_UNREACHABLE on every LAN host: macOS logged "local network blocked ...
# bundle_id: (null)" even though Local Network was toggled on for Mira.
set -euo pipefail

cd "$(dirname "$0")/.."

# Typecheck first: build:mac (electron-vite + electron-builder) transpiles with
# esbuild, which strips types WITHOUT checking them — so a type-broken tree would
# still package. Gate on tsc so this is always a real, clean build.
npm run typecheck

# Quit the running app first: replacing a bundle that's executing is unreliable.
osascript -e 'quit app "Mira"' 2>/dev/null || true

npm run build:mac

# Install: replace the bundle in place with a real copy. ditto preserves the code
# signature and extended attributes, which codesign validation needs.
rm -rf /Applications/Mira.app
ditto dist/mac-arm64/Mira.app /Applications/Mira.app

# `open -a`, never `open <bundle>`: a .app is a directory, and a plain `open` on a
# bundle that LaunchServices has not re-registered yet (which is exactly the state
# right after the ditto above) can fall through to the "folder" handler — it opens
# the file explorer and never launches Mira (seen 2026-08-22).
open -a /Applications/Mira.app
