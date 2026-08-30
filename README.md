# Mira

A personal, **Chromium-based** web browser. Sibling of [Kova](https://github.com/micktaiwan) (the terminal): small, personal, tailored to one user's workflow. `mira` = "look" (Latin _mirari_, to marvel) plus a star. A browser's job: show the web.

Built on **Electron** (Chromium + Node), with a React + TypeScript "chrome" and one `WebContentsView` per tab. The engine is embedded, not forked — Chromium is a dependency, we build the UI and features on top. See [`CLAUDE.md`](./CLAUDE.md) for the full architecture rationale, and [`track.md`](./track.md) for the live state of each work item.

## Two founding principles

1. **Everything is scriptable (IPC + socket + MCP).** Every action (navigate, open/close/switch a tab, back/forward/reload, add a bookmark, palette command…) is a **named, typed command** in a single registry on the main process — the sole source of truth for actions. The React UI never mutates browser state directly; it **sends a command**. The same registry is reachable over three transports: internal **IPC** (chrome ↔ main), an external **unix socket** (`MIRA_SOCKET`, one JSON request per line, to drive Mira from a shell or an agent), and **MCP** (a thin wrapper over the socket, planned).

2. **Everything is testable (one feature = one test).** Because logic lives in the command registry as named functions (not click handlers), it is tested with **Vitest** without launching Electron or Chromium. The native Electron bits (`WebContentsView` layout, `webContents` lifecycle) are not unit-tested; if a command is too coupled to Electron to test, its pure logic is extracted into a separate helper.

## Current state

- **Increments 1→3 done:** an Electron window with a `WebContentsView`, an address bar that navigates, and the command registry.
- **External control socket** (`MIRA_SOCKET`) alongside IPC — the "everything scriptable" surface.
- **Multi-window profiles** (Chrome model): one profile = one window with its own isolated session. A profile has a stable **id** (which owns its cookies, in partition `persist:mira-<id>`) and a renamable **label**; renaming never touches the id, so cookies are preserved. The list is persisted to `profiles.json` in userData. Opening an already-open profile focuses its window. Profile switching lives in the **native app menu**.
- **Settings window** (Cmd+,): a dedicated window to list, create, and rename profiles (renaming keeps the id/cookies). It only sends registry commands, like the rest of the chrome.
- **Vertical Arc-style tabs**, with folders, per-tab memory ranking, and detaching a tab into its own window.
- **What is in flight** is tracked in `track.md`, not here — this section only sketches the shape.

## Available commands

The registry lives in `src/main/commands/`, **one file per domain** (`navigation.ts`, `tabs.ts`,
`screenshot.ts`…) merged by `commands/index.ts`. Adding a command touches only its domain file —
the split exists so parallel sessions do not collide on one giant registry file.

There are far more than fit here, and a hand-maintained copy is exactly what rots — this file
used to list seven commands and name a `commands.ts` that no longer exists. So it does not try:

- **The live answer** is the `list-commands` command, which every build computes from its own
  registry — it can never go stale.
- **The reference** (params, results, exact error strings) is [`docs/socket.md`](./docs/socket.md).

A representative handful, callable identically over IPC, socket, or (later) MCP:

| Command         | Params                         | Effect                                                         |
| --------------- | ------------------------------ | -------------------------------------------------------------- |
| `navigate`      | `{ url, newTab? }`             | Normalize input and load it, in place or in a fresh tab        |
| `list-tabs`     | `{ windowId? }`                | Every tab of a window: id, title, url, loaded, audible         |
| `exec-js`       | `{ code, tabId? }`             | Run JS in a tab's page world, return its serializable value    |
| `get-console`   | `{ tabId?, level?, limit? }`   | Read back a tab's captured page console, after the fact        |
| `screenshot`    | `{ path?, tabId?, fullPage? }` | Capture a tab to a PNG file                                    |
| `list-profiles` | —                              | Every known profile (`{ id, label, open }`) and the focused id |
| `open-profile`  | `{ id }`                       | Open a profile's window, or focus it if already open           |

## Project layout

```
src/main/       main process — window, WebContentsView, command registry, socket, profiles, native menu
src/preload/    secure bridge main ↔ renderer (contextBridge)
src/renderer/   the React UI (the "chrome")
src/cli/        pure logic of the `mira` CLI (the bin is a thin I/O shell over it)
bin/mira        the CLI itself — runs against a live Mira, no build step
docs/socket.md  the external control protocol: every command, its params and its errors
```

Key files: `src/main/commands/` (the registry, one file per domain), `src/main/socket.ts` (external
transport), `src/main/profiles.ts` (window/profile lifecycle), `src/main/index.ts` (wiring).

## Development

```bash
npm install
npm run dev        # dev + HMR (long-running; main-process changes need a full restart)
npm test           # Vitest — the registry logic
npm run typecheck  # tsc, no build
npm run build      # typecheck + build
npm run lint       # eslint
npm run format     # prettier
```

Drive a running Mira from a shell with the `mira` CLI (`bin/mira`), which speaks the control
socket for you — default `/tmp/mira.sock`, override with `MIRA_SOCKET`:

```bash
mira tabs                              # every tab: id, title, url (* = active, z = asleep)
mira open example.com                  # open in a NEW tab (nav loads in place instead)
eval "$(mira use --url example.com)"   # pin that tab for this shell (exports MIRA_TAB)
mira exec "document.title"             # run JS in the pinned tab, print the result
mira shot /tmp/page.png --full         # capture the pinned tab to a PNG
mira commands                          # what this build actually knows
mira call <command> --params '<json>'  # passthrough to any command
```

Do **not** drive the socket with `printf … | nc -U`: macOS `nc` closes as soon as stdin hits EOF
and therefore drops any asynchronous reply — `exec-js` comes back as zero bytes, which reads as a
hang rather than as the client bug it is. The CLI reads until the newline the server always
appends. Its pure logic lives in `src/cli/mira-core.mjs` and is unit-tested.

## Notes

- All code, comments, identifiers, and UI text are in **English**.
- `postinstall` (`electron-builder install-app-deps`) currently fails (electron-builder 26 + Node 22 ESM bug) — no impact on dev, only on packaging.
