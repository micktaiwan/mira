#!/usr/bin/env bash
# Build Mira and refresh the installed app.
#
# /Applications/Mira.app is a SYMLINK to dist/mac-arm64/Mira.app (set up once,
# see below), so `build:mac` rewriting that folder in place is all it takes to
# "install" the latest build — no copy step. Same spirit as the kova binary symlink.
#
# One-time setup (only if /Applications/Mira.app is not already the symlink):
#   rm -rf /Applications/Mira.app
#   ln -s "$PWD/dist/mac-arm64/Mira.app" /Applications/Mira.app
set -euo pipefail

cd "$(dirname "$0")/.."

# Typecheck first: build:mac (electron-vite + electron-builder) transpiles with
# esbuild, which strips types WITHOUT checking them — so a type-broken tree would
# still package. Gate on tsc so this is always a real, clean build.
npm run typecheck

# Quit the running app first: replacing a bundle that's executing is unreliable.
osascript -e 'quit app "Mira"' 2>/dev/null || true

npm run build:mac

open /Applications/Mira.app
