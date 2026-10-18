# Automation — making Mira driving fast

Brief for a dedicated session. Written after a session that drove a heavy web app by hand
for twenty minutes and measured where the slowness came from.

## What the measurement says — and what it does not say

**Mira is not slow.** Measured with `/usr/bin/time -p`, Mira running with several profiles
open and over a hundred tabs, on a loaded page of a heavy web app:

| What is measured | Duration |
| --- | --- |
| raw socket round trip (python client, trivial `exec-js`) | **< 1 ms** |
| `mira exec` end to end (node process included) | **40 ms** |
| `mira exec` of an `innerText` on the whole web app page | 40 ms |
| `mira tabs`, `mira windows` | 40–50 ms |
| `mira press` | 60 ms |
| `mira shot` | 110 ms |
| **three `exec-js` pipelined on ONE connection** | **< 1 ms in total** |

⚠️ **Measurement trap, do not repeat it.** Timing by wrapping the command between two
`python3 -c 'time.time()'` gives 226 ms on *everything*, `mira help` included — which does
not even touch the socket. That is python starting up under pyenv (200 ms), not Mira. Use
`/usr/bin/time -p`, or the shell's `time`.

**What is slow is the shape of the driving: one command = one process = one agent turn.**
The sequence used as a case study (open the web app's settings and reach a nested settings
pane) cost ~25 calls, including **35 seconds of blind `sleep`** and **five calls just for
one click**, two of which failed. None of these costs is in Mira; all three come from
capabilities missing from the CLI.

At the time of writing, `mira commands` returns ~120 commands and **none** matches `click`,
`mouse`, `wait`, `batch`, `scroll` or `type` — only `press-key` exists.

## The three workstreams, in this order

### 1. `mira batch` — fold N turns into one

**The biggest gain for the least code, and the daemon is already ready.** Verified: three
JSON requests sent back to back on a single connection get their three responses, in less
than a millisecond. The protocol is already JSON-per-line. **So there is nothing to do on
the main side: it is a CLI-only change.**

Today `bin/mira` opens a connection, sends **one** request, reads **one** response and
exits (it is written at the top of the file). Every command therefore pays for a node
process, and above all an agent turn.

What is needed:

```bash
mira batch @script.mira        # a file, one command per line
mira batch -                   # or from stdin
```

- Line format: exactly what you would type after `mira` (`exec document.title`,
  `press , --mod meta`, `wait --text Settings`), plus `#` comments and empty lines ignored.
- A single connection, pipelined requests, responses read in order.
- **Stop at the first failure by default** (`--keep-going` to continue): in an automation
  sequence, everything after a failed click is noise.
- Output: one line per command, prefixed with its index, plus a summary
  `N ok, M failed`. `--json` returns the raw array of responses.
- Exit code: 0 if everything passes, 1 otherwise.
- The tab target (`--tab` / `$MIRA_TAB` / `--profile`) is set **once** on the `batch`
  command and applies to every line, each line being able to override it.

Where: the parsing logic goes in `src/cli/mira-core.mjs` (pure, tested); `bin/mira` only
does the I/O. Add the parser's unit tests next to it.

### 2. A conditional wait — kill the `sleep`s

Without it, an agent writes `sleep 3`: too long when the page is already ready (that is the
perceived slowness), too short when it is not (that is the false negative, much worse — you
conclude "the element does not exist" when it arrives 200 ms later).

New registry command, **new domain file** `src/main/commands/wait.ts` (+ its
`WaitContext` slice, + `wait.test.ts`, + the import/spread line in `commands/index.ts` — it
is the only shared line to touch, cf. `.claude/rules/command-registry.md`).

```bash
mira wait --selector '[role=dialog]'      # waits for it to appear
mira wait --text 'Settings'               # waits for a visible text
mira wait --url '/settings'               # waits for a navigation
mira wait --gone --selector '.spinner'    # waits for a disappearance
```

- Polling **inside the page** (through the same path as `exec-js`), not on the node side: a
  socket round trip per attempt would be absurd at 50 ms intervals.
- `--timeout` in ms, default 5000. When exceeded: `ok:false` with a message that says
  **what was looked for and for how long** — never a silent success.
- Returns the time actually waited, so the caller sees what it costs.
- ⚠️ `exec-js` cuts off at 5 s (seen on an upload, cf. the `mira` skill): the polling must
  not be one long `await` in a single `exec-js`, otherwise it dies at 5 s. Either a loop on
  the main side that re-evaluates, or a per-attempt timeout well below that.

### 3. A real mouse — `mira click`

**It is the gap that costs the most per occurrence.** `press-key` goes through CDP
`Input.dispatchKeyEvent`, so `isTrusted: true`. It has **no mouse equivalent**: every click
has to be rebuilt by hand in `exec-js`, dispatching `pointerdown` / `mousedown` /
`pointerup` / `mouseup` / `click` with the right `clientX`/`clientY`, on the right ancestor
— and many apps ignore these synthetic events. In the case study, it took five calls and
two failures for a single click on "Settings".

```bash
mira click --selector 'button[aria-label=Close]'
mira click --text 'Settings'          # first visible element carrying this text
mira click --at 320,180               # viewport coordinates
mira click --text 'Réglages' --nth 2  # disambiguation
```

Implementation: **`Input.dispatchMouseEvent`** (`mousePressed` then `mouseReleased`,
`button: 'left'`, `clickCount: 1`), exactly the same path as `pressKeyInTab` in
`src/main/profiles.ts:5779` — reuse its mechanics as is:

- same tab resolution and same errors as `exec-js` (`webContentsForTab`);
- **same visibility guard** (`ensurePageVisibleForInput`): Chromium only delivers input to a
  visible tab, and a hidden tab swallows the click while answering `ok` — the worst kind of
  failure. Fail loudly rather than lie;
- same debugger discipline: only attach if nobody is attached, only detach what we attached
  ourselves (leave the stealth shim's one alone).

Target resolution: `--selector` / `--text` are resolved **inside the page** into a
`getBoundingClientRect()`, then we click at the center. Refuse if the element is outside
the viewport or zero-sized, and say so (and offer `--scroll`, which does `scrollIntoView`
first, rather than clicking into the void).

The command goes in **`src/main/commands/input.ts`**, the domain already exists and it is
exactly its job (the file says "the keyboard counterpart to exec-js" — the mouse is the
missing third pillar). The pure name→payload translation lives in `src/main/input-keys.ts`
for the keyboard; do the same for the mouse, in the same file or a sibling
`input-mouse.ts`, to stay testable without Electron.

## Already done, do not redo

**The `press-key` punctuation bug is fixed** in the working tree, with its tests (17 pass,
`npx vitest run src/main/input-keys.test.ts`): `src/main/input-keys.ts` now has a
`PUNCTUATION` table (each character → its real US `code`: `,` → `Comma`, `?` → `Slash`,
`*` → `Digit8`) and a `PUNCTUATION_ALIASES` table (the spelled-out names the shell passes
unquoted: `Comma`, `Slash`, `Space`…).

The symptom, to understand the bug class: `resolveKey` returned `code: ''` for any
punctuation. Typing a character only needs `text`, but a **shortcut matches on `code`** —
so `Cmd+,` (the settings of Notion, Slack, VS Code) went out, answered `ok`, and did
nothing. A failure that presents itself as a success.

⚠️ **This fix is not in the running build.** It needs a rebuild (`./bin/build.sh`) to be
checked for real — and **a rebuild is asked of the user**, it quits Mira, and therefore the
other sessions using it.

## Constraints to respect (they come from the repo, not from me)

- **A command = a name + a params schema in the registry**, reachable identically through
  IPC, socket and MCP. None of this must be a CLI trick that hacks around in `exec-js` —
  except `batch`, which really is pure CLI.
- **One file per domain** in `src/main/commands/`, and a single shared line to touch (the
  import + the spread in `index.ts`). Mira is vibe coded across several sessions in
  parallel: two sessions in the same file = overwrite. Detail:
  `.claude/rules/command-registry.md`.
- **One feature = one test** (Vitest, `npm test`). If a command is too coupled to Electron,
  extract its pure logic and leave only the native call.
- **Never call `focus-app` or `mira focus`** to get unstuck. It is the user's everyday
  browser, open behind other windows: every raise cuts off what they are typing. If a
  command fails because the window is hidden, say so.
- **Test on a `--background` tab, in an isolated profile**, not on the user's own tabs. See
  `.claude/rules/piloting-and-testing.md`.
- **Do not launch or kill any process without asking** (so no `npm run dev`, no
  `build.sh`, no relaunching Mira on your own initiative).

## What proves it is done

Replay the sequence used as the case study — open the web app's settings and reach the
nested settings pane — **in a single `mira batch`**, without a single `sleep`, without a
single `exec-js` that builds `MouseEvent`s by hand. It cost 25 calls and twenty minutes; it
must fit in a ten-line file.
