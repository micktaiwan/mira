---
description: "Drive Mira, a fully scriptable Chromium browser, through its `mira` CLI: target a tab, run JS in a page, open or navigate, extract text, capture a PNG. For pages behind a login that WebSearch and WebFetch cannot reach. Use when: 'look at the page I have open', 'in my browser', 'on LinkedIn', 'read this tab', 'regarde la page que j'ai ouverte', 'dans mon navigateur', 'lis cet onglet', or when the information sits behind the user's logged-in session."
---

# Mira — a scriptable browser

A Chromium browser (Electron + React/TS, one `WebContentsView` per tab). This skill lives in the
mira repo (`skill/`); the full socket reference is `docs/socket.md` in the same repo. Founding
principle: everything is scriptable, every action is a named command in a single registry.

**If a `LOCAL.md` sits next to this file, read it first.** It carries what is specific to the
machine and its user: paths, profiles, working rules, incidents. It is excluded from git.

## `TabId: <uuid>` in a message = a Mira tab, always

When a user message carries a `TabId: <uuid>` line ("read this doc", "look at this"…), it is the
id of a **Mira tab** that Mira attached to the message. It is never a tab of another tool (Claude
Docs, Notion…), even when the word "doc" is in the sentence. Go straight to
`mira exec --tab <uuid> "document.body.innerText"`, without trying other tools first.

**A page whose content is images** (a signature viewer such as Signaturit, pages rendered as lazy
`<img src="blob:…">`): `innerText` only returns the chrome. For each page, `scrollIntoView()`, wait
for `naturalWidth > 0`, draw it into a canvas and export a `toDataURL('image/jpeg')` that you decode
into a file, then read the image. The viewer unloads off-screen pages: capture them one by one, not
all at once.

## The CLI, not `nc`

The CLI is the repo's `bin/mira`, to put on the PATH as `mira`. It runs without a build. **Do not
drive the socket with `nc -U`**: macOS `nc` closes on stdin EOF and misses the asynchronous reply
(`exec-js` returns zero bytes, which looks like a false "empty").

**`mira help` prints the full, current usage** — it rereads its own file header, with no side
effect and no process launched. It is the living source; what follows is only the common path.

```bash
mira tabs                              # tabs (id / ages / title / url); * = active, z = asleep, ♪ = sound
mira tabs --window <id>                # ANOTHER window's strip (ids from `mira windows`)
mira windows                           # open windows (id / profile / tabs), * = focused
mira close-window --params '{"windowId":"<id>"}'  # close ONE window (no id: the focused one)
eval "$(mira use --url <substr>)"      # pin a tab → export MIRA_TAB=<uuid> (also: use <id>, use --active)
mira exec "document.title"             # exec-js in the pinned tab (or the active one if nothing is pinned)
mira press e --mod meta,shift          # a REAL keystroke (CDP, isTrusted) — for keyboard-driven web apps
mira click --text 'Settings'           # a REAL mouse click (CDP) — also --selector <css>, --at x,y, --nth n, --scroll
mira wait --selector '[role=dialog]'   # wait for it to appear instead of sleeping (--text, --url, --gone, --timeout ms)
mira batch @script.mira                # N lines over ONE connection: one process, one agent turn (--keep-going)
mira console --level error --limit 50  # the page's captured console: console.*, 403/CORS/CSP, exceptions
mira shot /tmp/page.png                # PNG capture of the pinned/active tab (--full = whole page)
mira reload                            # reload the pinned or active tab (on the error page: retries the failed url)
mira open example.com [-b]             # OPEN X → new tab, leaves the current tab alone (-b: hidden tab)
mira nav example.com                   # "go to X" → loads in place, OVERWRITES the pinned/active tab (-n: new tab)
mira done                              # close this Claude session's windows (see below)
mira focus [--window <id>]             # bring ONE window to the front — FORBIDDEN unless explicitly asked
mira watch                             # live stream of the watched tab (Ctrl-C to quit)
mira cookies [--url <url>]             # cookie string of the active site, HttpOnly included
mira commands                          # list-commands of the running build
mira call <command> --params '<json>'  # passthrough to any command
```

Three commands never to run on your own initiative, only when the user asks:
`mira forget <domain> [--profile <id>]` wipes the cookies, storage and history of a domain and all
its subdomains (irreversible, logs the site out); `mira quit` closes Mira entirely — and so for the
other sessions using it too; it is the only clean exit for a script, and the only one that skips
the "Quit Mira?" confirmation (an `osascript -e 'quit app "Mira"'` triggers it, and nobody is there
to answer); and `mira focus` / `focus-app`, the only door left to bring Mira in front of the user
(see just below).

`./bin/build.sh` rebuilds the packaged app: it quits Mira through the socket, waits for the process
to end and relaunches it **in the background** (`open -g -a`). The Cmd+Q "Quit Mira?" dialog stays
for the human (Cmd+Q is one key away from Cmd+W); scripts skip it.

**None of these commands brings Mira to the front.** A command that arrives through the socket
does its work without ever activating the app: the user keeps typing in their editor while tabs
open, pages load, keys are sent. On top of that, `-b` (`--background`) on `mira open` opens the tab
**hidden**: the window does not even switch to it, so nothing moves on screen — the default mode
for testing a page.

**A window the socket creates opens below the frontmost one, not on top** (`open-profile` on a
closed profile, `detach-tab`, a session window). It stays fully drivable while covered: `exec`,
`shot` and `requestAnimationFrame` work there (measured 2026-09-26). Code from 2026-09-26
(`src/main/window-order.ts`): **it only applies to a Mira built after that day**. On an older
build, the window still lands on top of every app, without taking the keyboard.

## One window per Claude session

**Each Claude session gets its own Mira window, per profile** (code from 2026-09-26, same caveat:
only on a Mira built after that day). Without `--tab`, `$MIRA_TAB` or `--window`, `exec`, `click`,
`wait`, `press`, `reload`, `shot`, `console`, `nav`, `open` and `batch` target the session's
window, recognised by `CLAUDE_CODE_SESSION_ID`. Mira creates it on the first call, below the
frontmost window, with a home tab, and never saves it in the session.

```bash
mira open https://example.com --profile perso   # session window in the "perso" profile
mira shot                                        # same window, nothing to repeat
mira done                                        # close the session's windows
```

- **Several profiles open and no `--profile` on the first call: refused**, never guessed (same
  rule as below). A session that already has a window in two profiles must name one too.
- **`mira tabs` and `mira use` stay on the user's window**: they are how you find the page the
  user has open. To act on it, pass `--tab <id>` on every command.
- Mira closes by itself the windows of a session whose Claude process has died (every 30 s).
  `mira done` at the end of a task is still the polite move.
- `MIRA_NO_SESSION_WINDOW=1` turns the mechanism off. On an older build, the CLI says so on stderr
  and falls back to the old targeting.

## `mira focus` is forbidden unless asked

**CRITICAL — `mira focus` / `focus-app` is FORBIDDEN until the user has asked for it, and "I need
it for my test" is not asking.** It is the only door the foreground policy leaves open
(`src/main/foreground-policy.ts`: the rest of the socket is already muzzled, and a native addon
even swallows the activation Chromium triggers by itself). So when Mira jumps in front while the
user is working, it is **almost always a Claude session that called it**. Every raise cuts off
what they were typing.

- **The tell**: I am about to write `focus` or `focus-app` because a command just failed. The
  right reflex is to find the command that aims at the right target (`--tab` / `$MIRA_TAB` /
  `--window` / `--profile`, `activate-tab` to make a tab visible without raising the window), or
  to tell the user what is blocking. Never raise the window to make your own life easier.
- **The same goes for relaunching the app.** `open -a Mira` and any script ending in an `open`
  without `-g` bring Mira to the front, exactly the same from the user's point of view.
- **Measuring corollary**: do not switch apps to observe a behaviour (`osascript … to activate`) —
  `mira windows` marks the focused window with `*`, and marks none when Mira is in the background.
  That is enough to know whether Mira is in front, without moving anything.

## Keyboard, mouse, waiting, sequences

`mira press` is a keystroke dispatched through CDP with `isTrusted: true`, the only one that works
on apps that ignore synthetic DOM events (archive with `e`, navigate with `j`/`k`, `Escape`).
Chromium drops a key sent to a hidden page, so the tab is made visible in ITS window before sending
(and the window put back on screen if it was minimised or covered) — always without activating the
app. If the page stays invisible, the command fails instead of lying: tell the user and ask them to
bring the window forward, **not** call `focus-app` to get unstuck.

`mira click` is the mouse counterpart of `mira press`, and exists for the same reason: a
`MouseEvent` built in `exec-js` carries `isTrusted: false` and most real apps ignore it — or handle
only part of it, which is worse, since the call answers `ok` and nothing moves. The target is
resolved INSIDE the page (`--selector`, or `--text` which keeps the deepest element carrying that
text), then clicked at its centre. It refuses rather than click into nothing: an invisible element,
one outside the viewport (`--scroll` brings it in first), or one covered by something else at that
point — the error says which.

`mira wait` replaces `sleep`. A `sleep 3` is too long when the page is already ready, and too short
when it is not — and that second case does not read as "too early", it reads as "the element does
not exist", two hundred milliseconds before it appears. It returns the time actually waited, and on
timeout it says what it was looking for and for how long.

`mira batch` folds a sequence into a single turn. One line = what you would type after `mira`
(`#` lines and blank lines are ignored), everything goes over one connection, and **it stops at the
first line that fails** (`--keep-going` to continue): after a missed click, the rest would run
against a page that is not in the expected state. The tab target is set once on the `batch` command
and each line can override it with its own `--tab`. Three verbs are not allowed and say so: `watch`
(never returns), `use` (only prints an export for the shell) and `batch` itself. `nav` and `open`
require a named tab there, otherwise they refuse — without a named window, a page can load in the
wrong profile.

`mira console` saves opening the devtools to understand why a page breaks: the per-tab buffer keeps
`console.*` **and** what the browser emits on its own (failed loads, 403, CORS, CSP, uncaught
exceptions), cross-origin iframes included. `--since <seq>` returns only what is new, for polling.

Target tab resolution, stateful through the environment (never a shared file, so no collision
between parallel sessions): `--tab <id>` > `$MIRA_TAB` > the Claude session's window > the active
tab of the focused window. A stale `MIRA_TAB` fails loudly (`unknown tab: <id>`, exit 1); it never
quietly falls back to the active tab. **`nav` and `open` honour it too**: `nav` loads into the
pinned tab wherever it lives, `open` opens the new tab next to it — so in ITS window, not the
focused one. Verbose exec-js code: `mira exec @file.js` or `… | mira exec -` to dodge shell
quoting. `--json` gives the raw reply. Exit 0 or 1 depending on `ok`, 2 on a transport error. The
socket is `/tmp/mira.sock`, overridable with `--socket <path>` or `$MIRA_SOCKET`.

## One profile per identity — resolve the profile BEFORE opening

Mira holds **several profiles**, one per identity (personal, work). A personal subject opens in the
personal profile, a work subject in the work profile: aiming at the wrong one lands on a login
screen while the user is already logged in right next door — or worse, loads the page with the
other identity's cookies, session and history.

**It does not sort itself out, and the trap is silent.** A socket command without a `profileId`
targets the **focused** window — and when Claude drives from a terminal, **no Mira window has
focus**: `getFocusedWindow()` returns `null` and Mira falls back to **the first open window**,
which is not necessarily the right one (`docs/socket.md`, § Targeting).

**The CLI refuses to guess.** When several profiles have an open window and no target is named,
`mira nav` and `mira open` exit with an error listing the windows and their labels, instead of
picking one. Three ways to name the target, in order of preference:

```bash
mira open <url> --profile perso     # matches the profile LABEL (or an id prefix)
mira open <url> --window <id>       # id from `mira windows`
mira open <url> --tab <id>          # or $MIRA_TAB, if a tab is already pinned
```

⚠️ **`export MIRA_TAB=…` does not survive from one Bash call to the next**: each command runs in a
fresh shell. So either `--profile`/`--tab` on **every** command, or `export … && mira …` in the
**same** call. (The session window, above, solves this for the common case.)

`mira call list-profiles` gives the labels and ids (`{ id, label, open }`), and the focused id is
often `null` — that is the root of it all.

**The CLI also checks that the running Mira honours the target.** Before sending the real URL, it
opens an `about:blank` at the target and looks where it lands; if the build ignores the `tabId`, it
refuses and says so, rather than load the page under another profile. Such a refusal means the fix
is in the working tree but not in the running build: a rebuild to suggest to the user, never to
launch yourself.

An unknown or locked `profileId` returns `{ok:false}` — not a crash, a refusal to read. Same logic
to target a specific window: `mira windows` gives the id, `mira tabs --window <id>` reads the right
strip.

## Capturing a page as an image

`mira shot [path] [--full]` writes a PNG and prints `path  WxH  N KB  (viewport|full page)`. It is
the only way to check a rendering the DOM does not describe — a canvas, a 3D scene, a layout that
collapses.

- Without a path, the file goes to `userData/screenshots/shot-<timestamp>.png` and the CLI says
  where.
- The path is made absolute from the calling shell's cwd, `~` included; the daemon refuses a
  relative path, because Mira's cwd has nothing to do with yours.
- Extension: `.png` is mandatory (added if missing, refused if different) — the bytes are PNG.
- `--full` captures the whole document through CDP. Two limits, announced rather than hidden: past
  16384 px tall the capture is cut and the result carries `clamped: true`; and nothing forces
  lazy-loading, so a page that fills in on scroll comes out with its placeholders.
- To check a local page, serve the folder then capture: Mira can open a `file://`, but a local
  server avoids origin restrictions on JS modules.

## Uploading a file into a web app — the "Upload" button can be automated

An *Upload* button opens a **native** file picker that nothing drives from the page. So do not let
it open: **intercept** the `<input type=file>` beforehand, and hand it the file yourself.

The recipe, in three successive execs (the page's JS context persists between them as long as you
do not reload):

1. **Patch the click**, then open the menu and click the *Files* entry. The input often does not
   exist in the DOM before that click, and is created on the fly:

```js
window.__grabbed = null;
const orig = HTMLInputElement.prototype.click;
HTMLInputElement.prototype.click = function () {
  if (this.type === 'file') { window.__grabbed = this; return; }   // the native picker never opens
  return orig.apply(this, arguments);
};
```

2. **Inject the file**: rebuild the bytes as a `Uint8Array`, turn them into a `File` **carrying the
   exact expected name**, pass it through a `DataTransfer`, then `dispatchEvent(new Event('change',
   {bubbles:true}))`. Assigning `input.files` directly is not enough, the app listens to `change`.

3. **Answer the name conflict.** On a file that already exists, the app offers "Replace / Keep
   both" — often **outside a `[role=dialog]`, as a plain banner at the bottom of the page**, so
   invisible to whoever only reads dialogs. Click the button whose `innerText` is `Replace`: it adds
   a version instead of duplicating. **Until it is clicked, nothing is uploaded**, even though the
   injection answered without error.

**Three traps seen on a SharePoint OneDrive:**

- **`mira exec` times out at 5 seconds.** A 4.8 MB `.docx` is 6.4 MB of base64: the script ends in
  `executeJavaScript timed out`. The fix is to push the base64 in **~1.6 MB chunks** into a
  `window.__parts = []`, then finish with a short script that `join('')`s, builds the `File` and
  dispatches — with no long `await`, the page finishes the upload on its own.
- **The file list does not refresh** after the upload: it still shows the old date. `mira reload`
  then reread, otherwise you conclude a failure that is not one.
- **The only check that counts is to download the file again and reread its content.** The UI can
  show "modified 3 minutes ago" on a document holding none of our changes: a **Word Online** tab
  opened earlier takes over and rewrites the file on top. Close the online editor's tab before any
  re-upload, and compare the size — neither the original's nor ours = a third party wrote.

**When the site's API refuses but the UI works.** Common on a guest share: SharePoint answered
`403 accessDenied` on `_api/contextinfo` and on three forms of `PUT` (REST as well as Graph/Vroom),
with a valid `X-RequestDigest`, while the link carried `roles: ["write"]` — a guest authenticated
by one-time code has no API rights. So an API 403 does **not** prove read-only access: try the UI
before concluding.

## Traps

- Every request without a `tabId` binds to the focused window **at call time**: flaky with several
  windows, prefer an explicit `tabId`. Also true of `nav`/`open`: with no pinned tab (and no session
  window), they target the focused window.
- An asleep tab (lazy-load, discard) makes page-bound commands fail (`tab is asleep`); `select-tab`
  wakes it.
- **Every tab carries three ages** (columns between the id and the title, in this order): since it
  opened, since it was last visited, since its page last changed — `3d`, `4h`, or `-` when the data
  is missing (a tab never looked at, or restored from a session older than the feature). In JSON
  (`--json` / `list-tabs`): `openedAt` / `lastActiveAt` / `updatedAt`, in epoch ms or `null`. That
  is how to spot what has been lying around before suggesting a close — a `-` in last-visited is
  NOT a fresh tab, it is a tab never opened.
- **Which tab made a sound**: `mira call list-audio-history` returns the open tabs (all profiles)
  that played sound, currently playing first then most recent first (`lastAudibleAt`, epoch ms, set
  at the start and end of the sound, persisted). Same list in Settings → Audio.
- By default `mira tabs` only lists the focused window, but no tab is out of reach: `mira windows`
  gives the ids, `mira tabs --window <id>` reads any strip. An unknown id fails
  (`unknown window: <id>`) instead of falling back to the focused window.
- On the macOS side, a window is called `Mira — <profile>` (Mission Control, Window menu, System
  Events). They were all called `Electron` before 2026-08-28, so an old recipe that targets a
  window by index in AppleScript is stale: go through `mira focus --window <id>`.
- **Extract a page's text in one go, never in slices.** Return the `innerText` in a single call, no
  `slice()`. Cutting "to be safe" creates a false need for a patch (a second script to fetch the
  end), doubles the calls and misses content. Only split if the page is truly huge, and say so
  explicitly.
- **Type long text into a field with `execCommand('insertText')`, not N `press` calls.** A
  250-character sentence is 250 round trips with `press`, several minutes. The fast path is one
  call: click the field (or `focus()` it), then `document.execCommand('insertText', false,
  '<text>')` — the browser inserts it like a real keystroke, so React and controlled forms
  (Typeform, Notion, most SPAs) see it. ⚠️ **Setting `input.value` directly does not work** on a
  React field, even through the native `HTMLInputElement.prototype` setter followed by a
  `dispatchEvent('input')`: the value is rewritten on the next render and the field comes out
  empty, with no error. To replace the content rather than append, `t.select()` before inserting.
  `execCommand` returns `false` when the field is not really focused — the signal to click it
  first, not to retry. ⚠️ `mira exec` times out at 5 seconds, so a huge text is still pushed in
  chunks (see the upload recipe above).

## Improving the CLI as you go

Whenever a command fails, misbehaves, is missing, or forces a workaround (falling back to the raw
socket, guessing a param name, living with a friction), **tell the user** instead of absorbing it
silently, and propose the fix in the source (`bin/mira` and `src/cli/mira-core.mjs` in the repo).

## Manual audio analysis

In the Media panel, **Analyze page audio** runs a one-off analysis of the current page.
CLI: `mira call analyze-page-audio --params '{"tabId":"<id>"}'` → `{media, count, unavailable}`.
No download, no playback started, no automatic capture hook. The analysis checks the blobs of the
audio elements present (20 sources max, total read budget 32 MB) and adds the audio sources already
seen on the network. MediaSource, expired or oversized blobs are reported as unavailable; this is
not a stream recorder.

A second click downloads a recoverable sound. By command:
`mira call download-page-audio --params '{"url":"blob:…","tabId":"<audioTabId>"}'`.
Use the `audioTabId` returned on the analysis item; the blob must still be that of an audio element
in that tab. The file goes to Downloads. Plain HTTP URLs still go through `download-media`. The
analysis does not recover the segments of a vanished stream and does not replay the page.
