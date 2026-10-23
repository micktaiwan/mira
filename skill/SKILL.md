---
description: "Drive Mira, a fully scriptable Chromium browser, through its `mira` CLI: target a tab, run JS in a page, open or navigate, extract text, act on a page by number (click, type, pick an option), capture a PNG. For pages behind a login that WebSearch and WebFetch cannot reach. Use when: 'look at the page I have open', 'in my browser', 'on LinkedIn', 'read this tab', 'regarde la page que j'ai ouverte', 'dans mon navigateur', 'lis cet onglet', or when the information sits behind the user's logged-in session."
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

**A page whose content is images** (an e-signature viewer, pages rendered as lazy
`<img src="blob:…">`): `innerText` only returns the chrome. For each page, `scrollIntoView()`, wait
for `naturalWidth > 0`, draw it into a canvas and export a `toDataURL('image/jpeg')` that you decode
into a file, then read the image. The viewer unloads off-screen pages: capture them one by one, not
all at once.

## The CLI, not `nc`

The CLI is the repo's `bin/mira`, to put on the PATH as `mira`. It runs without a build. **Do not
drive the socket with `nc -U`**: macOS `nc` closes on stdin EOF and misses the asynchronous reply
(`exec-js` returns zero bytes, which looks like a false "empty").

**Every socket request must name its caller** (`"client"`), or Mira refuses it. The CLI fills it
by itself (`mira-cli session=<CLAUDE_CODE_SESSION_ID> cwd=<dir>`, prefixed by `$MIRA_CLIENT`
when set); a raw client writes it. Mira logs each request with that name in
`<userData>/command.log`, and `activation.log` quotes the last one whenever Mira comes to the front.

**`mira help` prints the full, current usage** — it rereads its own file header, with no side
effect and no process launched. It is the living source; what follows is only the common path.

```bash
mira tabs                              # tabs (id / ages / title / url); * = active, z = asleep, ♪ = sound
mira tabs --window <id>                # ANOTHER window's strip (ids from `mira windows`)
mira tabs --profile personal           # the user's window of that profile (label or id prefix)
mira tabs --session                    # YOUR session window's strip (never opens one; --profile if several)
mira windows                           # open windows (id / profile / tabs), * = focused
mira close-window --params '{"windowId":"<id>"}'  # close ONE window (no id: the focused one)
eval "$(mira use --url <substr>)"      # pin a tab → export MIRA_TAB=<uuid> (also: use <id>, use --active)
mira exec "document.title"             # exec-js in the pinned tab (or the active one if nothing is pinned)
                                       # prints {"ok":true,"result":…}: a shell `case *true*` matches "ok":true
mira exec --bare "!!document.querySelector('x')"   # the result alone (exit 1 on failure): use it in shell tests
mira press e --mod meta,shift          # a REAL keystroke (CDP, isTrusted) — for keyboard-driven web apps
mira click --text 'Settings'           # a REAL mouse click (CDP) — also --selector <css>, --at x,y, --nth n, --scroll
mira snap                              # the page as a numbered list of what you can act on + its visible text
mira click 12                          # click element [12] of the last snap
mira type 3 London                     # replace the text of field [3] of the last snap
mira select 2 Business                 # pick option "Business" of dropdown [2] (--value <v>: by value)
mira wait --selector '[role=dialog]'   # wait for it to appear instead of sleeping (--text, --url, --host, --gone, --timeout ms)
mira batch @script.mira                # N lines over ONE connection: one process, one agent turn (--keep-going)
mira console --level error --limit 50  # the page's captured console: console.*, 403/CORS/CSP, exceptions
mira shot /tmp/page.png                # PNG capture of the pinned/active tab (--full = whole page)
mira reload                            # reload the pinned or active tab (on the error page: retries the failed url)
mira open example.com [-b]             # OPEN X → new tab, leaves the current tab alone (-b: hidden tab)
mira nav example.com                   # "go to X" → loads in place, OVERWRITES the pinned/active tab (-n: new tab)
mira done                              # close this Claude session's windows (see below)
mira focus [--window <id>]             # bring ONE window to the front — FORBIDDEN unless explicitly asked
mira focus --tab <id>                  # make THAT tab active, then raise its window (same ban applies)
mira watch                             # live stream of the watched tab (Ctrl-C to quit)
mira cookies [--url <url>] [--netscape] # cookie string of the tab's site, HttpOnly included; --tab reads THAT tab's profile
                                       # --netscape: a cookie jar for yt-dlp --cookies / curl -b (Instagram reels need the login)
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
`shot`, real input and `requestAnimationFrame` work there — **on a Mira built after 2026-10-02**.
Before that build, a window entirely covered by another one painted no frame and dropped every
`click`, `press` and `type` while answering ok (see "A click that answers ok" below). Code from 2026-09-26
(`src/main/window-order.ts`): **it only applies to a Mira built after that day**. On an older
build, the window still lands on top of every app, without taking the keyboard.

## One window per Claude session

**Each Claude session gets its own Mira window, per profile** (code from 2026-09-26, same caveat:
only on a Mira built after that day). Without `--tab`, `$MIRA_TAB` or `--window`, `exec`, `click`,
`snap`, `type`, `select`, `wait`, `press`, `reload`, `shot`, `console`, `nav`, `open` and `batch` target the session's
window, recognised by `CLAUDE_CODE_SESSION_ID`. Mira creates it on the first call, below the
frontmost window, with a home tab, and never saves it in the session.

```bash
mira shot --profile personal                     # session window in the profile labelled "personal"
mira exec "document.title"                       # same window, nothing to repeat
mira done                                        # close the session's windows
```

**Opening a page never adds a window when its profile is already open** (CLI, 2026-10-13).
`mira open` (and `nav -n`) puts the new tab in the user's existing window of that profile, says so
on stderr, and returns the tab id: act on it with `--tab <id>` from then on, or the next tab verb
creates the session window anyway. A session window is only created when the profile has no window
open. In-place `nav` still goes to the session window, so it never overwrites the user's active tab.
The reason: one more window per session multiplies windows for nothing.

- **Several profiles open and no `--profile` on the first call: refused**, never guessed (same
  rule as below). A session that already has a window in two profiles must name one too.
- **`mira tabs` and `mira use` stay on the user's window**: they are how you find the page the
  user has open. To act on it, pass `--tab <id>` on every command. To list your OWN session
  window, `mira tabs --session` (fails if the session has no window yet; never opens one).
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

**A click that answers ok, then nothing happens.** After every `click`, `press` and `type`, Mira
asks the page whether it received the event, and fails with `input was dropped: …` when it did not
(code from 2026-10-02: **only on a Mira built after that day**; the same build also stops Chromium
from freezing a covered window, which was the cause, so the error should now be rare). On an older
build the same situation answers `clicked …` and the page gets nothing: four clicks were lost that
way on a login page, in a session window fully covered by another app. So on any build, when an
action has no visible effect, check delivery before blaming the page:

```bash
mira exec "window.__seen=0; addEventListener('pointerdown',()=>__seen=1,true); 'armed'"
mira click --text 'Sign in'
mira exec "__seen"          # 0 = the page never got the click
```

What to do when input is dropped, in this order:

1. Do the action through the page's own code when it has one (`form.requestSubmit()`, the app's
   global client, `element.click()` where a synthetic click is enough). `exec` keeps working in a
   covered window.
2. Redo the step in a hidden tab of one of the user's own windows, where input was measured to
   land: `MIRA_NO_SESSION_WINDOW=1 mira open <url> -b --window <id>` (id from `mira windows`), then
   `--tab <id>` on every command, and `mira call close-tab --params '{"id":"<id>"}'` at the end.
3. Tell the user the window is covered. Never `mira focus`.

`mira click` is the mouse counterpart of `mira press`, and exists for the same reason: a
`MouseEvent` built in `exec-js` carries `isTrusted: false` and most real apps ignore it — or handle
only part of it, which is worse, since the call answers `ok` and nothing moves. The target is
resolved INSIDE the page (`--selector`, or `--text` which keeps the deepest element carrying that
text), then clicked at its centre. It refuses rather than click into nothing: an invisible element,
one outside the viewport (`--scroll` brings it in first), or one covered by something else at that
point — the error says which.

**To act on a page (click, fill a form, pick an option), start with `mira snap`.** It prints one
line per button, link, field and dropdown, each with a number and its current value, then the
text visible in the viewport:

```
[1] textbox "Where to?" = "Paris"  (type, click)
[2] combobox "Class" = "Economy"  (select)  options: "Business"
[4] button "Search"
```

Then act by number: `mira click 4`, `mira type 1 London`, `mira select 2 Business`. No screenshot
to read, no selector to guess, and the click and the typing are real (CDP) like `mira click`.

**Snap again after every action.** A numbered action is refused (`the page changed since the
snapshot: take a new one`) as soon as the page moved since the snap, and your own previous action
counts: after `type`, the field's value changed, so the next `click` needs a fresh snap. This is
on purpose: it stops a click from landing on whatever replaced the element you read. In a
`mira batch`, write it as `snap` / `type 1 London` / `snap` / `click 4`.

**A page with a live countdown or clock (an OTP form's "4:57") invalidates every snap within a
second**: the ticking text sits in the form context the guard compares. Separate `mira snap` and
`mira type` calls then fail with `the page changed since the snapshot`. Put the snap and the action
in ONE `mira batch` (milliseconds apart, so the timer does not tick between them), or fill and
submit through `mira exec` (`input.value = …; input.form.requestSubmit()`), which worked on a plain
server-rendered form.

What snap does not see: elements inside iframes or shadow DOM, canvas apps, password and file
fields, and text below the fold (scroll, then snap again). For those, fall back to
`mira click --selector/--text` and `mira exec`.

**Reading a page whose content lives in a cross-origin iframe** (a hosted artifact or embed: the
top document's `innerText` holds only the header): `mira exec` cannot reach into the frame, and
opening the frame's `src` in its own tab usually redirects back to the parent page (the frame
token is bound to its embedder). What works is reading pixels: `mira click --at <x,y>` on an
empty spot of the frame to focus it, `mira press Home`, then `mira shot` and `mira press PageDown`
in a loop until two consecutive shots have the same `md5`, and read the PNGs.

`mira wait` replaces `sleep`. A `sleep 3` is too long when the page is already ready, and too short
when it is not — and that second case does not read as "too early", it reads as "the element does
not exist", two hundred milliseconds before it appears. It returns the time actually waited, and on
timeout it says what it was looking for and for how long.

**`--url` matches anywhere in the address, query string included.** A login page carries the site it
will return to (`?redirect_url=https://app.example.com/…`), so `mira wait --url example.com` holds
on the identity provider's page, one millisecond in. To wait for the tab to be back ON a site, use
`mira wait --host example.com` (the hostname or a subdomain of it; a Mira built after 2026-10-02).

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
On a timeout (`--timeout <seconds>`, default 30) the CLI probes Mira once and says which case it
is: `Mira is responsive … this command itself was slow` (wait, or retry with a longer timeout), or
`Mira is frozen` with the pid. A frozen Mira has its main thread blocked: a socket `quit` cannot get
through, `sample <pid> 3` shows where it is stuck, and only killing the process recovers it, which is
the user's call (ask first). `Mira closed the connection without answering` means it quit or
crashed mid-request.

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
mira open <url> --profile personal  # matches the profile LABEL (or an id prefix)
mira open <url> --window <id>       # id from `mira windows`
mira open <url> --tab <id>          # or $MIRA_TAB, if a tab is already pinned
```

⚠️ **`export MIRA_TAB=…` does not survive from one Bash call to the next**: each command runs in a
fresh shell. So either `--profile`/`--tab` on **every** command, or `export … && mira …` in the
**same** call. (The session window, above, solves this for the common case.)

`mira call list-profiles` gives the labels and ids (`{ id, label, open }`), and the focused id is
often `null` — that is the root of it all.

The folder a profile's side terminal (the Kova pane running claude) starts in is a per-profile
setting: `mira call set-profile-terminal-cwd --params '{"id":"<profile>","cwd":"~/some/folder"}'`
(must exist; `""` or `null` = back to home), read back as `terminalCwd` in `list-profiles`. It
applies to the next pane created: a running pane keeps its folder until claude exits or the window closes. The user also sets it in Settings > Profiles.

**The CLI also checks that the running Mira honours the target.** Before sending the real URL, it
opens an `about:blank` at the target and looks where it lands; if the build ignores the `tabId`, it
refuses and says so, rather than load the page under another profile. Such a refusal means the fix
is in the working tree but not in the running build: a rebuild to suggest to the user, never to
launch yourself.

An unknown or locked `profileId` returns `{ok:false}` — not a crash, a refusal to read. Same logic
to target a specific window: `mira windows` gives the id, `mira tabs --window <id>` reads the right
strip, and `mira tabs --profile <p>` does both in one call. Raw socket, on a Mira built after
2026-10-08: `list-tabs` takes `profileId` and refuses any other unknown key (a stray `"profile"` used to list the focused window).

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

**First try `mira upload <file>... [--selector <css>] [--nth <n>]`.** It does step 2 below for you:
base64 in chunks (so a big file passes the exec timeout), `File` with the right name and MIME type,
`DataTransfer`, `input` + `change` events, and the React `onChange` fallback. It prints the names
and sizes the input now holds, and fails with the number of matches when the selector finds no
input. When the input already sits in the DOM (most upload forms: a "Browse…" button over a
visible or hidden input), that one command is the whole job; then `mira wait --text` on the page's
own "processing done" message. The manual recipe below stays for inputs created on click.

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
   **If the page does not react to that event, call the input's own React handler**: on a React
   app the dispatched `change` can be ignored (it worked once on an avatar uploader, then failed
   every time after, a reload included). The handler sits on the element:
   `const k = Object.keys(inp).find(k => k.startsWith('__reactProps')); inp[k].onChange({target: inp,
   currentTarget: inp, preventDefault(){}, stopPropagation(){}, persist(){}})`. That went through
   on the first try. Check the dialog's text afterwards; it must move on to its next step.

3. **Answer the name conflict.** On a file that already exists, the app offers "Replace / Keep
   both" — often **outside a `[role=dialog]`, as a plain banner at the bottom of the page**, so
   invisible to whoever only reads dialogs. Click the button whose `innerText` is `Replace`: it adds
   a version instead of duplicating. **Until it is clicked, nothing is uploaded**, even though the
   injection answered without error.

**Three traps seen on an online document library:**

- **`mira exec` times out at 5 seconds.** A 4.8 MB `.docx` is 6.4 MB of base64: the script ends in
  `executeJavaScript timed out`. The fix is to push the base64 in **~1.6 MB chunks** into a
  `window.__parts = []`, then finish with a short script that `join('')`s, builds the `File` and
  dispatches — with no long `await`, the page finishes the upload on its own.
- **The file list does not refresh** after the upload: it still shows the old date. `mira reload`
  then reread, otherwise you conclude a failure that is not one.
- **The only check that counts is to download the file again and reread its content.** The UI can
  show "modified 3 minutes ago" on a document holding none of our changes: an **online editor** tab
  opened earlier takes over and rewrites the file on top. Close the online editor's tab before any
  re-upload, and compare the size — neither the original's nor ours = a third party wrote.

**When the site's API refuses but the UI works.** Common on a guest share: the site answered
`403 accessDenied` on its context endpoint and on three forms of `PUT` (its REST API as well as its
Graph-style API), with a valid request digest, while the link carried `roles: ["write"]` — a guest
authenticated by one-time code has no API rights. So an API 403 does **not** prove read-only access: try the UI
before concluding.

## Traps

- **`click --text` reads visible text only.** An icon-only button carries its name in `aria-label`
  or `title`, so `click --text 'Toggle comments'` answers `no match` while the control sits right
  there: use `click --selector "button[aria-label='Toggle comments']"`. `snap` lists such a button
  as `"button"` or `"?"`, which is the tell that its name is not in the DOM text.
- **A disabled button says why in a tooltip, and there is no hover verb.** When an action is greyed
  out, the reason hangs on its tooltip trigger (Base UI marks it `[data-base-ui-tooltip-trigger]`) and
  never shows up in the page text. Fire the
  pointer events yourself to make it render, then read it:
  `mira exec "(() => { const s = document.querySelector('[data-base-ui-tooltip-trigger]'); const r = s.getBoundingClientRect(); const o = {bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, pointerType: 'mouse', isPrimary: true}; for (const e of ['pointerover', 'pointerenter', 'pointermove']) s.dispatchEvent(new PointerEvent(e, o)); return 'hovered'; })()"`,
  then read `[role=tooltip]`. Guessing the reason instead costs several wrong fixes in a row.
- **Calling `mira` from an app or a launchd job, not a terminal**: `~/.local/bin/mira` is a node script
  (`#!/usr/bin/env node`), and such callers get launchd's bare PATH, where node is not: it fails with
  `env: node: No such file or directory`, which a caller that hides stderr sees as an empty answer. Give
  it the login shell's PATH (`zsh -lc 'printf %s "$PATH"'`, read once). And `tabs --json` is large
  (favicons in base64): read stdout while the process runs, never after it exits, or the pipe fills and
  both sides wait (both bugs were hit at once by a native app reading Mira's context).
- Every request without a `tabId` binds to the focused window **at call time**: flaky with several
  windows, prefer an explicit `tabId`. Also true of `nav`/`open`: with no pinned tab (and no session
  window), they target the focused window.
- An asleep tab (lazy-load, discard, auto-sleep; `z` in `mira tabs`) makes page-bound commands fail
  (`tab is asleep`). `mira reload --tab <id>` wakes it without switching the window to it, then
  `mira wait --tab <id> --host <site>` before the next `exec`; `select-tab` wakes it too, but makes
  it the visible tab. Auto-sleep puts a loaded tab to sleep once it has gone 12 h (setting:
  `get-auto-sleep` / `set-auto-sleep`, Settings > Tabs) without being on screen (counted from its
  opening if it never was), except the active, pinned, keep-awake and
  audible tabs and a page holding typed, unsent text; `mira call auto-sleep --params
  '{"dryRun":true}'` lists what the next sweep would take.
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
- **Type text into a field with `mira type <ref> <text>` (after a `mira snap`), not N `press`
  calls.** A 250-character sentence is 250 round trips with `press`, several minutes; `type` is one
  call that clicks the field for real, selects what is there and inserts the text through CDP.
  **`document.execCommand('insertText', false, '<text>')` is the fallback**, for a field `snap`
  does not see (iframe, shadow DOM): it works on React and controlled forms (Typeform, Notion, most
  SPAs), but not everywhere. Seen on an e-mail field that turns addresses into tags: the
  text was in the DOM value, the form had not seen it and its submit button stayed disabled, while
  `mira type` followed by `mira press ,` produced the tags. So after an `execCommand`, read the
  form's state (button enabled, tag present), not the field's value. ⚠️ **Setting `input.value` directly does not work** on a
  React field, even through the native `HTMLInputElement.prototype` setter followed by a
  `dispatchEvent('input')`: the value is rewritten on the next render and the field comes out
  empty, with no error. To replace the content rather than append, `t.select()` before inserting.
  `execCommand` returns `false` when the field is not really focused — the signal to click it
  first, not to retry. ⚠️ **In a cross-origin iframe, `execCommand` stays `false` even after the
  click**: `mira exec` runs in the top document, which cannot reach the iframe (`click --text` then
  answers `no match` too). Seen on a login provider's 2FA modal. What works: `mira shot`, read the
  coordinates, `mira click --at <x,y>` (screenshot pixels), then `mira type --focused <text>`: it
  replaces the content of whatever field has focus, iframe included, in one call. (Mira builds
  before 2026-10-20 lack `--focused`: one `mira press <char>` per character there.) ⚠️ `mira exec` times out at 5 seconds, so a huge text is still pushed in
  chunks (see the upload recipe above).
- **A tab that is not the active one in its window has no layout at all.** `innerWidth` and
  `innerHeight` read `0x0`, so `snap` returns an empty list, `click --selector` finds nothing, and
  `shot` writes a blank or absurdly narrow PNG (measured: `413×2541` and a 12 KB solid image). This is not the "covered window" case above — the window can be perfectly visible, the
  tab just is not on top of its own strip. It bites every `-b` (background) tab, which is the
  default way to work. **The fix is `mira call activate-tab --params '{"id":"<tab>"}'` on a tab of
  YOUR OWN session window**, which costs nothing (nobody is looking at that window) and never
  raises the app. Do not activate a tab in one of the user's windows: that switches what they are
  looking at. `exec` keeps working at `0x0`, which is exactly why the failure is silent — the text
  extraction succeeds and only the clicks and the screenshots come back empty. Partly: in such a
  tab, `el.innerText` on an element below `body` comes back as `""` (it depends on layout), while
  `document.body.innerText` still returns the text. Read sub-elements with `textContent` there, and
  `el.click()` from `exec` still fires the page's handlers.
- **A `mira exec` that times out at 5 s has still run in the page, and the action it fired is
  done.** The CLI gives up waiting; the JavaScript does not stop. So an `exec` that does something
  — clicking a button, submitting a form, POSTing — must never contain its own `await sleep`:
  write the waits as shell `sleep` between separate short `exec` calls. And **never retry a write
  `exec` that answered `executeJavaScript timed out`** without first reading the page: the first
  one probably worked. Measured on a web app: a loop of async execs that each slept ~7 s
  returned eleven timeouts in a row, created all eleven records anyway, and fired twice on six of
  them, leaving every task duplicated.

- **A site behind a Cloudflare managed challenge: read the tab that is already loaded, never
  reload it.** Measured on an account dashboard the user had open: a
  same-origin `fetch()` from that tab came back `403` with the challenge page instead of the HTML;
  the same URL opened with `open -b` sat on "Performing security verification" past a 30 s
  `wait`; and a `nav` of the user's own tab, meant to refresh it, landed on the "Verify you are
  human" checkbox — which only the user may tick, so the page was lost until they came back. The
  DOM of the tab as it stands is still readable with `exec`; read
  `new Date(performance.timeOrigin)` alongside it so the answer says how old that state is.
- **A success toast can carry `role="dialog"` too.** After confirming a modal, `wait --selector
  '[role=dialog]' --gone` then waits on the toast ("Member removed"), and while it shows, a `click`
  on a pager button below it fails with `the target is covered`. Wait for the change itself instead
  (`wait --text 'of 112'`), then for the toast to go before paging.
- **`mira wait` right after `mira reload` can match the page being replaced.** `reload` answers
  `ok` as soon as it is sent; a `wait --text` launched next found its text "after 1ms" in the
  old document. To know the reload happened, compare `performance.timeOrigin`
  before and after, or wait for something only the new page has.

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
