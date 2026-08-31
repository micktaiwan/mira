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
#
# Through the control socket, NEVER `osascript -e 'quit app "Mira"'`. An Apple
# Event quit lands on the confirmation gate (src/main/quit.ts) and puts up a
# "Quit Mira?" modal that no one is there to answer — osascript returns anyway,
# so the script marched on and rm -rf'd a bundle that was still executing. The
# socket `quit` command calls suppressQuitPrompt() by design, for exactly this.
if [ -S "${MIRA_SOCKET:-/tmp/mira.sock}" ]; then
  ./bin/mira quit >/dev/null 2>&1 || true
fi

# ...and actually WAIT for it to be gone: the socket answers "ok" the moment the
# quit is dispatched, well before the process exits (session flush, vault
# re-lock). Up to 20s, then carry on — a stuck app is louder than a silent skip.
for _ in $(seq 1 80); do
  pgrep -f 'Mira\.app/Contents/MacOS/Mira' >/dev/null 2>&1 || break
  sleep 0.25
done

npm run build:mac

# Install: replace the bundle in place with a real copy. ditto preserves the code
# signature and extended attributes, which codesign validation needs.
rm -rf /Applications/Mira.app
ditto dist/mac-arm64/Mira.app /Applications/Mira.app

# `open -a`, never `open <bundle>`: a .app is a directory, and a plain `open` on a
# bundle that LaunchServices has not re-registered yet (which is exactly the state
# right after the ditto above) can fall through to the "folder" handler — it opens
# the file explorer and never launches Mira (seen 2026-08-22).
#
# `-g` launches it WITHOUT bringing it to the foreground. A rebuild is asked for
# while the user is working in something else: Mira must come back where it was,
# behind. Same rule as the foreground policy for commands (foreground-policy.ts) —
# nothing raises Mira unless it was asked for.
open -g -a /Applications/Mira.app
