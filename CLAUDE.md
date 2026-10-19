# Mira

A personal web browser, my own, **based on Chromium** and **vibe coded**. Sibling of Kova (the terminal): short, personal, cut to fit my use.

Name: `mira` = "look" (Latin _mirari_, to marvel) + a star. A browser's job: display the web.

## Rules by area (`.claude/rules/`)

Knowledge specific to one area of the code lives in **path-scoped rules** that only load when you touch the files concerned (it lightens this CLAUDE.md, which is always loaded). Overview of the rules:

- `main-native-gotchas.md` (`src/main/**`): Electron native pitfalls — WebContentsView, `<webview>`, native overlay, AZERTY `globalShortcut`, macOS Spaces.
- `command-registry.md` (`src/main/commands/**`): anti-collision split of the command registry (one file per domain).
- `piloting-and-testing.md` (`src/main/**`, `docs/socket.md`, `scratchpad/**`, `*.test.ts`): driving Mira through the socket (raw client vs the `nc` trap, `exec-js`/`tabId`, test tab in `background`, isolated profile, `--profile`/`MIRA_PROFILE`).
- `packaging.md` (`electron-builder.yml`, `patches/**`, `bin/**`, `package.json`): `build:mac`, pinned app-builder-lib patch, `./bin/build.sh`.

## Architecture decision (settled, do not reopen without a reason)

Path **A**: we **embed** the Chromium engine, we do not fork it. Chromium is a dependency, not our codebase. We build the UI and the features on top of it.

Choice: **Electron** (Chromium + Node bundled). Picked for the mass of docs/examples — the ground where vibe coding fails the least. Rejected alternatives: NW.js (ecosystem too small), Tauri/Wails (system webview = **WebKit on Mac**, not Chromium → breaks the constraint).

## Founding principle: everything drivable (IPC + MCP)

**Every Mira action must be drivable by a program, not only with the mouse.** It is an architecture constraint, not a wish: it decides the structure of the code from the start.

Concrete consequences:

1. **A single command layer.** Every action (navigate, open/close/switch a tab, back/forward/reload, add a bookmark, palette command…) is a **named, typed command** in a central registry on the **main** side. It is the single source of truth for actions.
2. **The UI is just a caller.** The React chrome NEVER mutates the browser state directly: it **sends a command** (via IPC) that main executes. A click handler = an `invoke('command-name', params)`, not business logic in the renderer.
3. **Three transports, one bus.** The same command registry is reachable through:
   - **IPC** (internal): React chrome ↔ main.
   - **Unix socket** (external, Kova-style): `MIRA_SOCKET` (default `/tmp/mira.sock`), one JSON request per line, to drive Mira from a shell / an agent. **API reference: `docs/socket.md`**; live, the `list-commands` command lists the names known to the running build. **In practice, drive it through the `mira` CLI (`bin/mira`, on the PATH), not with `nc`: `mira tabs` / `mira use --url <s>` (pin via `$MIRA_TAB`) / `mira exec` / `mira call <cmd> --params '<json>'`. Pure logic + tests in `src/cli/mira-core.mjs`.** Detail (raw client, `exec-js`, test tabs, isolated profile): rule `.claude/rules/piloting-and-testing.md`.
   - **MCP**: a thin server that wraps the socket. It adds no logic, it exposes the existing commands.
4. **A command = a name + a params schema.** That way it can be called identically from IPC, socket or MCP, without rewriting.

Everyday design rule: before implementing an action in a React component, ask yourself "is this a registry command?". If yes (almost always), it lives in main and the component calls it. If a feature can only be reached by clicking, it violates the founding principle.

## Founding principle: everything testable (one feature = one test)

**Every feature comes with its test.** No feature code merged without a test that covers it. It is the direct corollary of the "everything drivable" principle: since the logic lives in the command registry (named, typed functions, not click handlers), it can be tested without launching Electron or Chromium.

- **Runner: Vitest** (natural, we are already on Vite via electron-vite). Command `npm test`.
- **What we really test = the command logic.** Every registry command has its unit test: inputs → expected effect / returned value. That is where 90 % of the value lives.
- **What we do NOT unit test = the Electron native bits** (positioning of the `WebContentsView`, `webContents` lifecycle, real IPC). We do it case by case, not systematically.
- **Design consequence:** if a command is too coupled to Electron to be tested simply, extract its pure logic into a separate (testable) function, and leave only the native call (thin, untested) in the command.

## Anti-collision split (parallel sessions)

Mira is vibe coded across **several sessions in parallel**. One file edited by two sessions = merge conflict or overwrite. The split therefore aims for **one file per feature**, so that two sessions working on two different topics touch different files.

**The detail (layout of `src/main/commands/`, rules for adding a command / a context slice / a domain) lives in the rule `.claude/rules/command-registry.md`.** Test before writing: "does my feature touch a file that another session is probably touching too?" — if yes, a new domain file rather than an append. Same principle for the other surfaces when they grow (CSS per surface, React components per feature under `renderer/src/features/<x>/`, `App.tsx` only assembles).

## Stack

| Layer          | Choice                                   |
| -------------- | ---------------------------------------- |
| Shell          | Electron (Chromium + Node)               |
| Build / HMR    | electron-vite                            |
| UI ("chrome")  | React + TypeScript                       |
| Style          | Tailwind _(to add — not wired yet)_      |
| Web content    | `WebContentsView` (one per tab)          |

## The mental model: two separate worlds

1. **The "chrome"** = the UI _around_ the web (tabs, address bar, sidebar, palette). It is our React window, our own HTML. Lives in `src/renderer/`.
2. **The web content** = the sites visited. Lives in isolated containers, one process per view.

The bridge: **`WebContentsView`** (modern Electron API). One tab = one `WebContentsView`, created on the **main** side (`src/main/`), positioned under the address bar, listened to (`did-navigate`, `page-title-updated`, `page-favicon-updated`) and driven (`loadURL`, `goBack`, `reload`). The chrome (renderer) and main communicate through **IPC**.

The **native pitfalls** of this bridge (manual repositioning of the view, overlay impossible without a native window, etc.) are in the rule `.claude/rules/main-native-gotchas.md`, loaded when editing `src/main/**`.

## Increment path

1. Electron window + **one** `WebContentsView` that loads a hard-coded URL.
2. Address bar that navigates (URL + enter → `loadURL`).
3. Back / forward / reload + title & favicon display.
4. **Multi-tab** (array of `WebContentsView`, one visible at a time) — first real complexity step (lifecycle, focus, layout on resize).
5. What makes Mira _mine_: Arc-style sidebar, keyboard shortcuts, `Cmd+K` command palette.

## Structure (electron-vite scaffold)

```
src/main/       main process (window, WebContentsView, IPC handlers)
src/preload/    secure bridge main ↔ renderer (contextBridge)
src/renderer/   the React UI (the "chrome")
```

## Commands

```bash
npm run dev        # dev + HMR (process long-running)
npm run build      # typecheck + build
npm run typecheck  # tsc, no build
npm test           # Vitest
npm run lint / format
./bin/build.sh     # packaged build + reinstalls the app (quit via the socket → build:mac → relaunch in the background)
./bin/release.sh patch  # PUBLISHES an unsigned GitHub release that updates itself (docs/releases.md)
```

**`npm run format` rewrites THE WHOLE repo, not the files you just touched.** The repo is not
prettier-clean (≈5800 `prettier/prettier` warnings at lint), so a `format` run to check two files
reformats dozens of others — in one case 54 files, +7486/−6130, after a three-file fix. No semantic
change, but the working tree becomes unreadable, it overwrites the in-progress work of the other
sessions, and **it cannot be undone** (destructive git commands such as `git checkout`/`restore`
are off limits here): the repair falls on the user. So format one specific file
(`npx prettier --write <file>`), and check with `npx eslint <file>`, never the scripts that sweep
the repo.

**The same trap holds for ONE existing file that is not prettier-clean**: `npx prettier --write`
on it reformats all of it, not just your lines. `docs/*.md` are the worst case: their tables get
re-padded, so a 10-line addition to `docs/socket.md` became a 226-line diff. Run `prettier --write`
only on files you created; on an existing file, check `npx prettier --check <file>` first, and if it
was already dirty, format your own lines by hand (`git diff --stat` tells you right away).

Packaging / packaged build details: rule `.claude/rules/packaging.md`.

## Notes

- **Language**: all code, comments, identifiers and UI text in **English**. French stays for the dialogue.
- **Public repo**: a regular personal code repo, published on GitHub. No git-crypt encryption, normal descriptive commits.
- **Unversioned local notes**: the personal workflow and the identity of the test profile live in `CLAUDE.local.md`, loaded automatically by Claude Code next to this file when it is present. It is git-excluded: **absent from a public clone, that is normal — do not report its absence or treat it as an error.**

## The `mira` skill is the public surface of this tool

`skill/SKILL.md` in this repo — `~/.claude/skills/mira` is only a link to `skill/` — describes
how a session, from anywhere on this Mac, uses mira: the commands, the paths, the ports, what it
is not allowed to do. It is **public** (the repo is): nothing personal in it. What is specific to
the user (their profiles, their paths, their working rules, the incidents that explain the rules)
goes in `skill/LOCAL.md`, excluded from git (its target is in `CLAUDE.local.md`), which the skill
reads if it exists. Nothing syncs the skill automatically.

This repo is public: nothing personal goes into any tracked file — the user's specifics go in skill/LOCAL.md or CLAUDE.local.md, both excluded from git.

**A change here that touches what the skill promises is carried over into the skill right away**:
a command or a flag, a socket or data path, a port, a default value, a config file name, a rule
about what a session may touch. A stale skill is worse than no skill at all, because a session
acts on what it says. After such a change, compare the skill with the code and fix what diverged.
