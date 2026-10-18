---
paths:
  - 'src/main/**'
  - 'docs/socket.md'
  - 'scratchpad/**'
  - '**/*.test.ts'
---

# Driving Mira over the socket + testing in an isolated profile

These notes apply when you drive a running Mira (tests, debugging) through the
control socket `MIRA_SOCKET` (default `/tmp/mira.sock`). Full protocol and
command list: `docs/socket.md`; live, the `list-commands` command lists the
names known to the running build.

**✅ First reflex: the `mira` CLI (`bin/mira`).** It is a thin client on top of the socket, written to kill exactly the frictions below (the `nc` trap, a `tabId` to resolve by hand, hand-built JSON). It runs without a build (`.mjs`, native ESM), against the live Mira. Invoke it by path: `<repo>/bin/mira <verb>` (this machine's absolute path: `CLAUDE.local.md`). Pure, tested logic in `src/cli/mira-core.mjs` (+ `.test.ts`).

```bash
MIRA="$(git rev-parse --show-toplevel)/bin/mira"
$MIRA tabs                              # list tabs (id / title / url), * = active
eval "$($MIRA use --url localhost:8000)" # pin a tab → export MIRA_TAB=<uuid> (current session)
$MIRA exec "document.title"             # exec-js on the pinned tab (or the active one if nothing is pinned)
$MIRA reload                            # reload the pinned tab (via exec-js) or the active one
$MIRA shot /tmp/page.png [--full]       # PNG capture of the pinned/active tab (--full = whole document)
$MIRA nav example.com                   # navigate the active tab
$MIRA click --text 'Settings'           # REAL CDP mouse click (--selector, --at x,y, --nth n, --scroll)
$MIRA wait --selector '[role=dialog]'   # wait instead of sleeping (--text, --url, --gone, --timeout ms)
$MIRA batch @script.mira                # N lines over ONE connection (--keep-going)
$MIRA commands                          # list-commands of the running build
$MIRA call select-tab --params '{"id":"<uuid>"}'  # generic passthrough to ANY command
```

Statefulness **through the environment, never a shared file**: `MIRA_TAB` pins "the tab to work on" for MY shell session only → two Claude sessions never overwrite each other's target. Precedence modelled on `--profile`/`MIRA_PROFILE`: `--tab <id>` > `$MIRA_TAB` > active tab of the focused window. Guard: a stale `MIRA_TAB` **fails loudly** (`unknown tab: <id>`, exit 1), it never quietly falls back to the active tab. Verbose exec-js code: `$MIRA exec @file.js` or `… | $MIRA exec -` (stdin), to dodge shell quoting. Raw JSON output: `--json`. Exit code 0/1 on `ok`, 2 on a transport error — so you can branch on it in Bash.

Under the CLI there is always the raw socket. **Do NOT drive it with `printf … | nc -U`.** macOS `nc` closes the connection as soon as stdin hits EOF (right after the `printf`), so it **misses every asynchronous reply**: `get-status` (instant reply) sometimes gets through, but `exec-js` and any command that `await`s (CDP, navigation…) return **0 bytes** — a misleading "empty" that looks like a hang or a bug in the command (verified; it once cost hours of believing exec-js was broken). Reliable fix: a **raw socket client** that reads up to the `\n`. Helper set up for debugging sessions: `scratchpad/mira.py` (`call({...})` / `execjs(tabId, code)`), to recreate if missing:

```python
import socket, json
def call(obj, timeout=30):
    s=socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.settimeout(timeout); s.connect('/tmp/mira.sock')
    s.sendall((json.dumps({'client': 'mira.py session=' + __import__('os').environ.get('CLAUDE_CODE_SESSION_ID', '-'), **obj})+'\n').encode()); buf=b''
    while b'\n' not in buf:
        c=s.recv(65536)
        if not c: break
        buf+=c
    return json.loads(buf.decode())
```

Quick shell workaround if you really need `nc`: keep stdin open for the duration of the reply — `{ printf '%s\n' '{…}'; sleep 1; } | nc -U /tmp/mira.sock`. But prefer the Python client.

## Shape of socket requests (traps hit in practice)

- **Field `"command"`, not `"cmd"`.** Some other control sockets use `{"cmd":…}`; Mira expects `{"command":…}`. A `"cmd"` returns `missing "command" field`.
- **Field `"client"` is mandatory** (who is calling: `"mira.py session=<id>"`, a script name). Without it: `missing "client" field`. It ends up in `<userData>/command.log`, and `activation.log` quotes it when Mira comes to the front. The `mira` CLI fills it by itself.
- **Params are nested under `"params"`, never flat.** `{"command":"install-extension","id":"…"}` fails with `"id" must be a non-empty string`. Correct shape: `{"command":"install-extension","params":{"id":"…"}}`. Full example: `{"client":"my-script","command":"navigate","params":{"url":"example.com"}}`.

## exec-js and test tabs

- **`exec-js` takes a `tabId`** (UUID from `list-tabs`): always pass it to aim at a precise tab. An asleep tab returns `{"ok":false,"error":"tab is asleep"}` (wake it with `select-tab`). For async code, `exec-js` may not await the promise in some builds — work around it with "start the async, store it in `window.__x`, reread synchronously" on a 2nd call.
- **No socket command brings Mira to the front.** Since the "foreground policy" fix (`src/main/foreground-policy.ts`), a command that arrives through the socket/MCP does its work without ever activating the app: `new-tab`, `navigate`, `open-url`, `open-profile`, `activate-tab`, `press-key`, `detach-tab`. Only `focus-app` raises Mira, and that is its only reason to exist — so **it is forbidden until the user has asked for it** (`mira` skill): it is the only door left to cut off what they are typing, and a session once went through it nine times in one afternoon to make its tests easier. The same command coming from the UI (click, Cmd+T) keeps the old behaviour. And a window **created** by the socket (`open-profile` on a closed profile, `detach-tab` into a new window) opens **below** the frontmost window, not on top (`src/main/window-order.ts`, trap #11 of `main-native-gotchas.md`). From a Claude Code session, the CLI works in the **session window** (`session-window`, one per profile, closed by `mira done` or when the process dies): details in `docs/socket.md` § "One window per agent session".
- **`background:true` is still useful, but for something else**: it stops the window from _switching_ to the new tab, so nothing moves on screen. `new-tab {background:true}`, `navigate {newTab:true,background:true}`, or `mira open <url> -b`. You get the `tabId` back in the reply and drive it through `exec-js`.
- **Isolated test profile.** A dedicated profile (separate session/cookies) exists so the real profiles are not polluted. Its concrete id and its usage live in `CLAUDE.local.md` (not versioned).

## A sequence = one `mira batch`, never N agent turns

Measured: the socket round trip is **under a millisecond**, a full `mira exec`
40 ms. What made driving slow was never Mira — it was a node process and above all
**one agent turn per command**. `mira batch @script.mira` (or `-` for stdin) replays N lines over
a single connection: one line = what you would type after `mira`, `#` and blank lines are ignored.

- **Everything is built before the first send**: a mistake on line 7 refuses the whole batch
  rather than leaving the page half-driven, in a state nobody described.
- **Stops at the first line that fails** (`--keep-going` to continue), because everything that
  follows a missed click runs against a page that is not in the expected state.
- **Refused verbs, with the reason**: `watch` (never returns), `use` (only prints an
  export for the calling shell), `batch` (no nesting). `nav` and `open` require a named tab
  there: without a named window, a personal page loads in the work profile.
- The tab target is set once (`mira batch --tab <id>`, or `$MIRA_TAB`) and each line can
  override it with its own `--tab`.

**And in a script, no more `sleep` and no more hand-built `MouseEvent`.** `mira wait`
(`--selector` / `--text` / `--url`, plus `--gone` and `--timeout`) polls the page every 100 ms and
returns the time actually waited; on timeout it says what it was looking for and for how
long. `mira click` (`--selector` / `--text` / `--at x,y`, plus `--nth` and `--scroll`) is a real
CDP click: the target is resolved in the page then clicked at its centre, and it refuses, saying so,
when the element is invisible, outside the viewport or covered — instead of clicking into nothing and
answering `ok`. Full examples: the `.mira` scripts under `scratchpad/`.

⚠️ `wait`'s polling is made of **many short evaluations**, never one long `await`
in the page: `exec-js` cuts off at 5 s (`cdp-eval.ts`), so a wait in a single call would die at
five seconds whatever `--timeout` was asked for.

## Driving with the keyboard (real keystrokes) and hidden tabs

For **keyboard-first** web apps (mail clients and the like: archive with `e`, `j`/`k`, `Escape`), use `press-key`, not a synthetic `KeyboardEvent` through `exec-js`.

- **Synthetic events are ignored.** A `document.dispatchEvent(new KeyboardEvent(...))` has `isTrusted:false`; these apps reject it (verified: a synthetic `l` does NOT open an app's Label menu). `press-key` goes through CDP `Input.dispatchKeyEvent` → `isTrusted:true`, indistinguishable from a physical keystroke.
- **CLI**: `mira press <key> [--mod alt,ctrl,meta,shift]`. `key` = a `KeyboardEvent.key`-style name (`e`, `Enter`, `ArrowDown`, ` `). Socket: `press-key {key, tabId?, modifiers?}`.
- **A real keystroke only reaches a VISIBLE tab.** Chromium silently drops input to a hidden tab (background / `document.visibilityState !== "visible"`). **OS focus of the window is NOT required** — a visible tab in an unfocused window still receives the keystroke (verified). `press-key` / `click` / `type` **bring the target tab to life first, without selecting it**: its view is shown BELOW the active tab's view (same bounds, bottom of the z-order, `src/main/input-underlay.ts`), so the user keeps the tab they are reading — **written but not yet verified on a running Mira**. Falls back to the old behaviour (the tab becomes active in ITS window) when nothing would cover it: Settings tab active, palette or gallery open. In both cases it waits one frame, **without ever raising or activating the window** (the `restore` + `showInactive` + `moveTop` was removed by 394d632: a covered window stays drivable, because `backgroundThrottling` is turned off on every tab, see `ensurePageVisibleForInput` in `profiles.ts`). It only fails (`page is hidden, input would be dropped`) if the tab is unknown, or if throttling is on and the page is still hidden, instead of a fake success — tell the user and ask them to bring the window forward, **not** call `focus-app` to get unstuck.

**Multiple windows & cross-window activation.** A profile can have several windows; `list-tabs`/`mira tabs` only show the target window's tabs, `mira windows` lists the windows (`*` = focused). Trap: `select-tab` only activates a tab in the **focused window** (`unknown tab` otherwise), whereas `exec-js`/`press-key` resolve the `tabId` across windows. To make a tab of ANY window visible: **`activate-tab {id}`** (makes it active in its window; it no longer raises the window from the socket). `mira tabs` marks the active/visible tab with `*` and asleep tabs with `z` (page-bound commands fail on them until they are woken).

## Launching Mira cold on a single profile (`--profile` / `MIRA_PROFILE`)

At startup, Mira reopens by default the profiles that were open at the last quit. To **start cold on a single profile** (typically the test profile), without reopening the others:

- CLI flag: `--profile <id>` or `--profile=<id>`.
- Or env variable: `MIRA_PROFILE=<id>` (the flag wins if both are set).

An unknown id is not fatal: Mira logs a warning and falls back to the normal restore (last open set). Pure, tested parsing in `parseProfileArg` (`src/main/profile-store.ts`), wired at boot in `src/main/index.ts` via `openSavedProfiles(explicitProfileId)`.

The mechanism is implemented and covered by unit tests; the exact shell invocation to inject the flag/env into the packaged app is **not yet verified for real** (`open -a Mira --args --profile <id>` should go through `--args`; whether `MIRA_PROFILE` is inherited through `open` remains to be confirmed). To validate on first use.

### "Scratch" dev: boot only the test profile, with its tabs restored

`npm run dev:scratch` (script in `package.json`) starts `electron-vite dev` with `MIRA_PROFILE` set to the test profile's id — that is, it boots THAT profile alone (the other real profiles are not reopened, nor rewritten at quit), **restoring its saved tabs** (`content: 'restore'`, no wipe) to resume tests where you left off. It shares the real userData (no isolation): on purpose, to keep the test profile's cookies/logins/tabs. The id lives in `.dev-scratch-profile` (git-excluded, absent from a public clone — the script then falls back to the normal restore, which is fine). It does not replace `npm run dev` (which reopens everything).
