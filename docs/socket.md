# Mira control socket

Mira is fully drivable from outside (the "tout pilotable" principle, see CLAUDE.md): a
unix-domain socket dispatches to the SAME command registry as the UI's IPC. This doc is
the API reference for that surface — what an agent or a shell needs to pilot Mira.

## The `mira` CLI (preferred over raw socket)

For shell/agent use, reach for **`bin/mira`** first — a thin client over this socket
that removes the hand-built JSON, the `nc` async-read trap, and the manual
list-tabs → filter → tabId dance:

```bash
bin/mira tabs                                # list tabs, * = active
eval "$(bin/mira use --url localhost:8000)"  # pin a tab → export MIRA_TAB=<uuid> (this shell only)
bin/mira exec "document.title"               # exec-js on the pinned/active tab
bin/mira reload                              # reload the pinned tab (via exec-js) or the active one
bin/mira call <command> --params '<json>'    # generic passthrough to any command below
```

Tab targeting is stateful via the environment (`--tab <id>` > `$MIRA_TAB` > active
tab); a stale `MIRA_TAB` fails loudly rather than silently hitting the active tab.
Pure logic + tests: `src/cli/mira-core.mjs`. The raw protocol below still underlies it.

## Protocol

- Path: `/tmp/mira.sock` (override with the `MIRA_SOCKET` env var).
- One JSON request per line; one JSON response per line.

```bash
printf '%s\n' '{"command":"navigate","params":{"url":"example.com"}}' | nc -U /tmp/mira.sock
# {"ok":true,"url":"https://example.com"}
```

- Request: `{"command":"<name>","params":{...}}` (`params` optional). `cmd` is a
  tolerated alias for `command` (Kova's socket uses `cmd`, so requests copy-paste
  across both); `command` stays the canonical form and wins if both are present.
- Response: `{"ok":true, ...result}` or `{"ok":false,"error":"..."}`.
- **Discovery**: `{"command":"list-commands"}` returns every command name the running
  build knows — always trust it over this doc if they disagree (this doc can lag).

## Targeting: which window, which tab

Each request binds to the **focused Mira window** at the moment it runs (fallback: any
open window). With several windows open this is flaky for an external caller — so
commands that can take an explicit target id should be preferred:

- Tab ids are **UUIDs, globally unique across all windows**. `exec-js` resolves its
  `tabId` across every open window; you are not tied to the focused one.
- `list-tabs` only lists the tabs of the target (focused) window — a tab living in
  another window is not discoverable yet (known limitation).
- A tab can be **asleep** (in the strip but not loaded — lazy-load / discarded).
  Page-bound commands fail on it (`tab is asleep: <id>`); `select-tab` wakes it.

## Commands

`params` legend: `?` = optional. Commands with no params listed take none.

### Discovery & status

| Command         | Params | Effect / result                                     |
| --------------- | ------ | --------------------------------------------------- |
| `list-commands` | —      | `{commands: string[]}` — every command name, sorted |
| `get-status`    | —      | memory usage + tab counts (total / loaded / asleep) |
| `list-tab-memory` | —    | cross-profile: every loaded tab ranked by its renderer-process memory; `{entries, totalBytes}` |
| `whoami`        | —      | id of the profile owning the target window          |

### Navigation (active tab of the target window)

| Command                               | Params           | Effect / result                                        |
| ------------------------------------- | ---------------- | ------------------------------------------------------ |
| `navigate`                            | `url`, `newTab?` | load a (normalized) url; `newTab:true` opens a new tab |
| `back` / `forward` / `reload`         | —                | session-history step / reload                          |
| `zoom-in` / `zoom-out` / `zoom-reset` | —                | active tab Chromium zoom (reflows the page)            |

### Default-browser handoff (last-focused profile, NOT the caller's active tab)

Mirrors what macOS does when Mira is the default browser / `.html` handler: opens in a **new tab of the last-focused profile window** (creating the default profile if none is open), unlike `navigate` which loads into the active tab. In the packaged app these fire from the OS `open-url` / `open-file` events; the socket commands exist so the same path is drivable and testable (the OS never routes those events to `npm run dev`).

| Command     | Params | Effect / result                                                                           |
| ----------- | ------ | ----------------------------------------------------------------------------------------- |
| `open-url`  | `url`, `profileId?`  | open a url in the last-focused profile, or in `profileId` when given (opens that profile if closed); result `{url, profileId?}` |
| `open-file` | `path`, `profileId?` | open a local file (absolute path → `file://`) in the last-focused profile, or in `profileId` when given; result `{url, profileId?}` |

`profileId` makes targeting **deterministic** from the socket: the last-focused fallback relies on OS focus state, which a background-app socket caller can't control (`getFocusedWindow()` is null, so it drifts to the first open window). Pass `profileId` (from `list-profiles`) to hit a specific profile. An unknown or locked id → `{ok:false}`.

**Single-instance forwarding.** macOS only routes `open`/double-click/clicked-link to the packaged bundle, never to `npm run dev`. So on boot, if the packaged app was launched by an open AND a Mira already answers on this socket (typically the running dev instance, same `/tmp/mira.sock`), it forwards the queued url(s) here via `open-url` and quits before creating a window — the page opens in the running Mira, no second app. Client side: `src/main/single-instance.ts`; boot guard: `src/main/index.ts` `whenReady`.

### Magnifier (optical loupe, active tab of the target window)

Persistent cursor-anchored optical zoom — a composited CSS transform on the page
root, so the page does NOT reflow (unlike `zoom-in`). Normally driven by Cmd+scroll
(zoom) / scroll (pan); these commands expose the same actions. While magnified,
clicks are swallowed (they'd land wrong), so it is a "look only" mode.

| Command           | Params                         | Effect / result                                                                              |
| ----------------- | ------------------------------ | -------------------------------------------------------------------------------------------- |
| `magnifier-zoom`  | `deltaY`, `cursorX`, `cursorY` | zoom by a wheel delta, anchored on the cursor (surface CSS px); returns `{scale, magnified}` |
| `magnifier-pan`   | `deltaX`, `deltaY`             | pan the loupe (surface px); returns `{magnified}`                                            |
| `magnifier-reset` | —                              | back to 100% (flashes a frame if it was zoomed)                                              |
| `magnifier-state` | —                              | current `{scale, originX, originY, magnified}`                                               |

### Find in page (active tab of the target window)

| Command                       | Params                          | Effect / result                                                                                                                                                                                          |
| ----------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `find-open`                   | —                               | show + focus the find bar in the window's chrome (Cmd+F). Fails when the active tab is not a web page                                                                                                    |
| `find-in-page`                | `text`, `forward?`, `findNext?` | start a search (`findNext:false`, default) or step it (`findNext:true`); highlights matches in the page. Match counts are pushed to the chrome (Chromium reports them asynchronously), not returned here |
| `find-next` / `find-previous` | —                               | step the remembered search (Cmd+G / Cmd+Shift+G); `{found:false}` when no search is active                                                                                                               |
| `find-stop`                   | `action?`                       | end the search; `action` is `clearSelection` (default), `keepSelection` or `activateSelection`                                                                                                           |

### Tabs

| Command                 | Params                | Effect / result                                                                                                                                                                                                           |
| ----------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list-tabs`             | —                     | `{tabs, activeId, panelCollapsed}` — tabs of the target window, with their UUID ids                                                                                                                                       |
| `new-tab`               | `url?`, `background?` | open a tab (default: home). `background:true` opens it hidden without switching to it or bringing Mira to the foreground — use this when driving a page from a script so Mira does not pop in front of what you are doing |
| `select-tab`            | `id`                  | activate a tab (wakes it if asleep)                                                                                                                                                                                       |
| `close-tab`             | `id`                  | close a tab                                                                                                                                                                                                               |
| `close-active-tab`      | —                     | close the active tab (Cmd+W semantics, pinned tabs are guarded)                                                                                                                                                           |
| `duplicate-active-tab`  | —                     | duplicate the active web tab (Cmd+Shift+D): open a copy of its live url right under it and focus it. No-op on the Settings tab or when nothing is active                                                                   |
| `discard-tab`           | `id`                  | unload a tab's page, keep the tab (frees RAM)                                                                                                                                                                             |
| `discard-active-tab`    | —                     | same, for the active tab                                                                                                                                                                                                  |
| `wake-all-tabs`         | —                     | re-open every tab that was awake (not asleep) at the previous quit; returns `woken` (Cmd+Shift+A)                                                                                                                          |
| `prev-tab` / `next-tab` | —                     | cycle the strip                                                                                                                                                                                                           |
| `pin-tab` / `unpin-tab` | `id`                  | pin state                                                                                                                                                                                                                 |
| `set-tab-awake`         | `id`, `keepAwake`     | keep a tab awake (never sleeps): woken in the background on restore, immune to discard. `keepAwake:false` clears it                                                                                                         |
| `move-tab`              | `id`, `toIndex`       | reorder the strip                                                                                                                                                                                                         |
| `detach-tab`            | `id`, `x?`, `y?`      | tear a tab off into its own window of the SAME profile (keeps the live page — no reload). With screen coords `x`/`y` (both or neither): if they fall inside another same-profile window, the tab RE-ATTACHES there; otherwise a new window opens at the point. Without coords, always a new window. `{windowId, created}`. No-op (`created:false`) when it is the source window's only tab and there is nowhere else to land. The sidebar's drag-out gesture drives this. |
| `move-tab-to-window`    | `id`, `windowId`      | move a tab into a specific existing window (same profile) — the deterministic counterpart to `detach-tab`. `{windowId}`. Errors: `unknown tab`, `unknown window`, cross-profile move                                       |
| `list-windows`          | —                     | `{windows}` — every open window: `{windowId, profileId, tabCount, bounds, focused}`. A profile can have several windows (a tear-off)                                                                                        |
| `reopen-closed-tab`     | —                     | restore the most recently closed tab                                                                                                                                                                                      |
| `toggle-tabs-panel`     | `collapsed?`          | collapse/expand the tab sidebar                                                                                                                                                                                           |
| `toggle-zen`            | `hidden?`             | zen (focus) mode: hide/show the toolbar, status bar, and both side panels at once. `hidden` omitted flips it; a boolean forces it. Exiting restores the panels to their pre-zen state. Cmd+Shift+H.                        |

### Page introspection (devtools domain)

| Command           | Params           | Effect / result                                                                                                                                                                                                                                    |
| ----------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exec-js`         | `code`, `tabId?` | run JS in a tab's page world, return its JSON-serializable value. With `tabId` (from `list-tabs`), targets **any tab in any window**; without, the active tab. Errors: `unknown tab: <id>`, `tab is asleep: <id>`, `not a web page (Settings tab)` |
| `toggle-devtools` | —                | open/close the inspector on the active tab                                                                                                                                                                                                         |
| `inspect-cookies` | —                | open the inspector on the active tab (if needed, never closes it) and reveal the Cookies view of the Application panel; result `{ open }`. Errors: `no active web page`                                                                            |

### Media (collect & download page media)

The media gallery (shortcut `Cmd+Alt+Shift+M`) collects every media on the page from **two sources**, merged with provenance: the live **DOM** (images, video/audio + sources, inline SVG, CSS backgrounds, canvas exported to PNG) and a **continuous per-tab network buffer** (every image / audio-video / font response that transited the wire, metadata only — no bodies held). Each item's `sources` lists `dom`, `network`, or both.

| Command                                      | Params                      | Effect / result                                                                                                                                                                      |
| -------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `collect-media`                              | `tabId?`                    | harvest the tab's media, merged + deduped. Result `{media: MediaItem[], count}`. `MediaItem = {url, kind, mime?, width?, height?, bytes?, alt?, sources[], tainted?, poster?, pageUrl?}`; `kind ∈ image | video | audio | svg | canvas | font | other`. `poster` is a video thumbnail; `pageUrl` is a streamed video's permalink (for `download-video-url`). Errors: `unknown tab`, `tab is asleep`, `no active web page` |
| `download-media`                             | `url` \| `urls[]`, `tabId?` | download to the Downloads folder via the tab's session (authenticated media keep the page's cookies); `data:` URLs (canvas/SVG) written directly. Result `{saved, failed[]}`         |
| `download-video-url`                         | `url`                       | download a streamed video (MSE/HLS/blob — X, YouTube…) as a real file via yt-dlp. `url` is the precise per-video permalink (from `collect-media`'s `pageUrl`), never the tab URL. Runs in the background. Result `{file}`; errors when yt-dlp is missing or extraction fails |
| `get-media-stats`                            | —                           | the target window's capture footprint plus in-flight yt-dlp downloads: `{count, bytes, text, downloads, downloadingSince}` (`text` = formatted RAM of the metadata buffer)          |
| `toggle-media-gallery`                       | `open?`                     | show/hide the fullscreen gallery overlay (hides the web view like the palette); result `{open}`                                                                                      |
| `open-media-gallery` / `close-media-gallery` | —                           | force the overlay open / closed                                                                                                                                                      |

### Skills & AI pane

| Command                               | Params                      | Effect / result                                                |
| ------------------------------------- | --------------------------- | -------------------------------------------------------------- |
| `list-skills`                         | —                           | skills applicable to the active page                           |
| `run-skill`                           | `id`                        | extract page content, run the skill's engine, show in the pane |
| `run-prompt`                          | `prompt`, `withScreenshot?` | one chat turn against the page (pane thread)                   |
| `get-skill-pane` / `close-skill-pane` | —                           | pane state / hide (keeps content)                              |
| `toggle-skill-pane`                   | `open?`                     | show/hide the pane                                             |
| `clear-chat` / `copy-chat`            | —                           | reset / copy the pane thread                                   |
| `set-chat-options`                    | `model?`, `loadMcp?`        | per-chat LLM options                                           |

### Bookmarks

| Command           | Params                        | Effect / result                  |
| ----------------- | ----------------------------- | -------------------------------- |
| `list-bookmarks`  | —                             | the whole bookmark tree          |
| `add-bookmark`    | `url?`, `title?`, `parentId?` | default: bookmark the active tab |
| `add-folder`      | `title`, `parentId?`          | create a folder                  |
| `open-bookmark`   | `id`                          | navigate to a bookmark           |
| `rename-bookmark` | `id`, `title`                 | rename a node                    |
| `move-bookmark`   | `id`, `parentId?`, `index?`   | reparent/reorder                 |
| `remove-bookmark` | `id`                          | delete a node                    |

### History

| Command          | Params            | Effect / result    |
| ---------------- | ----------------- | ------------------ |
| `list-history`   | `limit?`          | most recent visits |
| `search-history` | `query`, `limit?` | fuzzy search       |
| `clear-history`  | —                 | wipe it            |

### Profiles & windows

| Command                | Params        | Effect / result                                                                                                                                                                                                        |
| ---------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list-profiles`        | —             | profiles + which are open + focused id                                                                                                                                                                                 |
| `open-profile`         | `id`          | open (or focus) a profile window                                                                                                                                                                                       |
| `close-profile`        | `id`          | close a profile's window without quitting the app (`closed:false` if it was not open)                                                                                                                                  |
| `create-profile`       | `label?`      | new profile                                                                                                                                                                                                            |
| `rename-profile`       | `id`, `label` | rename                                                                                                                                                                                                                 |
| `set-profile-color`    | `id`, `color` | `#rrggbb` hex, or null/'' to clear                                                                                                                                                                                     |
| `focus-app`            | —             | bring Mira to the foreground                                                                                                                                                                                           |
| `list-spaces`          | —             | macOS virtual desktops per display, in Mission Control order, plus where the target window sits (`window: {displayId, spaceIndex}`, null when unknown). `displays: []` = no Spaces support (non-mac / addon not built) |
| `move-window-to-space` | `spaceIndex`  | move the target window onto that desktop (0-based index on its display). `moved:false` = was already there. Persisted: the window reopens on that desktop next launch                                                  |

### Vault (encrypted profiles)

A profile marked `encrypted` keeps its data (browsing trails + session partition) in an AES-256 sparsebundle at rest. Unlocking mounts it and copies the data back to the normal userData locations; locking re-encrypts and wipes the plaintext.

| Command            | Params            | Effect / result                                                                                                                                                            |
| ------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `encrypt-profile`  | `id`, `password`  | turn a profile into an encrypted one (creates its vault, moves data in, wipes plaintext). Leaves it LOCKED. Not the default profile; window must be closed                |
| `unlock-profile`   | `id`, `password`  | mount + restore the vault to its live locations so the window can open. Wrong password → `{ok:false}`                                                                      |
| `lock-profile`     | `id`              | copy the live data back into the vault and wipe the plaintext (`locked:false` if it was already locked). Close the profile window first                                   |
| `lock-all-vaults`  | —                 | lock EVERY currently-unlocked vault at once (closes each window, re-encrypts, wipes). Returns `{locked:[ids]}`. A panic-lock; also the path app quit uses to not lose a session left unlocked |
| `list-vaults`      | —                 | `{encrypted:[ids], unlocked:[ids]}`                                                                                                                                       |

### Settings

| Command                                      | Params                          | Effect / result                                                                          |
| -------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------- |
| `open-settings`                              | `section?`                      | open the Settings tab (`general`, `ai`, `profiles`, `extensions`, `permissions`, `data`) |
| `get-settings`                               | —                               | current app settings                                                                     |
| `set-home-url`                               | `url`                           | home page                                                                                |
| `set-llm-config`                             | `provider`, `apiKey?`, `model?` | AI engine (`claude-cli`, `anthropic-api`, `extractive`)                                  |
| `set-sidebar-width` / `set-skill-pane-width` | `width`                         | panel widths (px, clamped)                                                               |

### Cookies & data

| Command                | Params                                                    | Effect / result                                       |
| ---------------------- | --------------------------------------------------------- | ----------------------------------------------------- |
| `import-cookies`       | `to`, `profileDir`, `userDataDir?`, `safeStorageService?` | import Chrome cookies into a Mira profile             |
| `count-active-cookies` | —                                                         | cookies the active site would send                    |
| `clear-site-data`      | `url?`                                                    | cookies + storage for one site (default: active site) |
| `clear-data`           | `profile?`                                                | wipe a profile's browsing data                        |

### Extensions

| Command                                                          | Params | Effect / result                         |
| ---------------------------------------------------------------- | ------ | --------------------------------------- |
| `list-extensions`                                                | —      | loaded extensions of the target profile |
| `install-extension`                                              | `id`   | install from the Chrome Web Store id    |
| `load-extension`                                                 | `path` | load an unpacked extension              |
| `enable-extension` / `disable-extension` / `uninstall-extension` | `id`   | lifecycle                               |
| `update-extensions`                                              | —      | update all                              |
| `extension-console`                                              | `id?`, `level?`, `limit?`, `profileId?` | tail an extension service-worker's captured console (`messages[]`) |

`extension-console` reads a ring buffer of an MV3 service-worker's console output, captured since boot (Mira can't open devtools on a headless SW). All params optional: `id` filters to one extension, `level` is a minimum severity (`verbose` \| `info` \| `warning` \| `error`), `limit` caps to the most recent N (oldest-first), `profileId` picks which profile's session to read (default: the focused window's profile). The `profileId` matters because extensions are per profile: a passkey flow failing in the "pro" profile leaves nothing in the "perso" Bitwarden's worker. Each message is `{ extensionId, seq, level, message, sourceUrl, lineNumber }`; `seq` is monotonic so you can poll for what's new. Use it to see a background worker throw or never run (e.g. a passkey popout hitting an unimplemented `chrome.windows.create`).

### Permissions

| Command                                                                              | Params | Effect / result              |
| ------------------------------------------------------------------------------------ | ------ | ---------------------------- |
| `list-permissions` / `clear-permissions`                                             | —      | web-permission grant log     |
| `location-auth-status` / `request-location-authorization` / `open-location-settings` | —      | macOS location authorization |

### UI plumbing (used by the chrome; rarely useful externally)

`list-palette`, `toggle-palette {open?, mode?, query?}`, `show-tooltip {text, anchor}`,
`hide-tooltip`.

## Keeping this doc honest

Source of truth = the registry (`src/main/commands/`, one file per domain). When you add
or change a command, update its row here — and remember `list-commands` already exposes
the _names_ for free, so the only thing that can rot here is params/semantics.
