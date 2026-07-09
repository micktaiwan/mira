# Mira

A personal, **Chromium-based** web browser. Sibling of [Kova](https://github.com/micktaiwan) (the terminal): small, personal, tailored to one user's workflow. `mira` = "look" (Latin *mirari*, to marvel) plus a star. A browser's job: show the web.

Built on **Electron** (Chromium + Node), with a React + TypeScript "chrome" and one `WebContentsView` per tab. The engine is embedded, not forked — Chromium is a dependency, we build the UI and features on top. See [`CLAUDE.md`](./CLAUDE.md) for the full architecture rationale, and [`track.md`](./track.md) for the live state of each work item.

## Two founding principles

1. **Everything is scriptable (IPC + socket + MCP).** Every action (navigate, open/close/switch a tab, back/forward/reload, add a bookmark, palette command…) is a **named, typed command** in a single registry on the main process — the sole source of truth for actions. The React UI never mutates browser state directly; it **sends a command**. The same registry is reachable over three transports: internal **IPC** (chrome ↔ main), an external **unix socket** (`MIRA_SOCKET`, one JSON request per line, to drive Mira from a shell or an agent), and **MCP** (a thin wrapper over the socket, planned).

2. **Everything is testable (one feature = one test).** Because logic lives in the command registry as named functions (not click handlers), it is tested with **Vitest** without launching Electron or Chromium. The native Electron bits (`WebContentsView` layout, `webContents` lifecycle) are not unit-tested; if a command is too coupled to Electron to test, its pure logic is extracted into a separate helper.

## Current state

- **Increments 1→3 done:** an Electron window with a `WebContentsView`, an address bar that navigates, and the command registry.
- **External control socket** (`MIRA_SOCKET`) alongside IPC — the "everything scriptable" surface.
- **Multi-window profiles** (Chrome model): one profile = one window with its own isolated session. A profile has a stable **id** (which owns its cookies, in partition `persist:mira-<id>`) and a renamable **label**; renaming never touches the id, so cookies are preserved. The list is persisted to `profiles.json` in userData. Opening an already-open profile focuses its window. Profile switching lives in the **native app menu**.
- **Settings window** (Cmd+,): a dedicated window to list, create, and rename profiles (renaming keeps the id/cookies). It only sends registry commands, like the rest of the chrome.
- **In progress:** vertical Arc-style tabs. See `track.md`.

## Available commands

Registered in `src/main/commands.ts`. Callable identically over IPC, socket, or (later) MCP:

| Command | Params | Effect |
|---|---|---|
| `navigate` | `{ url }` | Normalize input and load it in the target window |
| `open-profile` | `{ id }` | Open the window for an existing profile id, or focus it if already open |
| `create-profile` | `{ label? }` | Create a new profile (fresh id + label) and open its window |
| `rename-profile` | `{ id, label }` | Relabel a profile; its id and cookies are untouched |
| `list-profiles` | — | List every known profile (`{ id, label, open }`) and the focused id |
| `open-settings` | — | Open the Settings window (profile manager), or focus it if already open |
| `whoami` | — | Return the target window's profile (`{ id, label }`) |

## Project layout

```
src/main/       main process — window, WebContentsView, command registry, socket, profiles, native menu
src/preload/    secure bridge main ↔ renderer (contextBridge)
src/renderer/   the React UI (the "chrome")
```

Key files: `src/main/commands.ts` (registry), `src/main/socket.ts` (external transport), `src/main/profiles.ts` (window/profile lifecycle), `src/main/index.ts` (wiring).

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

Drive Mira from a shell (default socket `/tmp/mira.sock`, override with `MIRA_SOCKET`):

```bash
printf '%s\n' '{"command":"navigate","params":{"url":"example.com"}}'   | nc -U /tmp/mira.sock
printf '%s\n' '{"command":"list-profiles"}'                                  | nc -U /tmp/mira.sock
printf '%s\n' '{"command":"create-profile","params":{"label":"Perso"}}'      | nc -U /tmp/mira.sock
# Profile commands target the stable id (from list-profiles), not the label:
printf '%s\n' '{"command":"rename-profile","params":{"id":"<id>","label":"Work"}}' | nc -U /tmp/mira.sock
printf '%s\n' '{"command":"open-profile","params":{"id":"<id>"}}'            | nc -U /tmp/mira.sock
```

## Notes

- All code, comments, identifiers, and UI text are in **English**.
- `postinstall` (`electron-builder install-app-deps`) currently fails (electron-builder 26 + Node 22 ESM bug) — no impact on dev, only on packaging.
