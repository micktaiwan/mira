# Plan — Chrome extensions in Mira (broad compatibility)

Laid out on 2026-07-09, put through the wringer (adversarial multi-agent review) on 2026-07-10.
Goal confirmed by the user: aim for **broad compatibility** with Chrome extensions
(not just 2-3 personal extensions). This doc is the implementation plan; progress lives in
`track.md`, the general architecture in `CLAUDE.md`.

Every external fact cited here was verified on 2026-07-09/10 (direct reading of the
READMEs, sources and issues — URLs in each section). Internal facts are anchored by
**function name + file** (no line numbers: the repo is edited by several sessions in
parallel, line numbers go stale within hours).

## 1. Feasibility verdict (honest)

"Broad compat" is reachable **for a large share of extensions**, with a ceiling that comes
from Electron itself, not from Mira:

| Category                                                                            | Verdict                | Why                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| UI/content extensions (Dark Reader, clippers, userscripts…)                         | ✅ realistic           | APIs covered by Electron + `electron-chrome-extensions`                                                                                                                                                                                                                                                                                                                              |
| Ad blocking                                                                         | ❌ **given up** (D3)   | The only extension route was uBlock MV2 (`chrome.webRequest`, covered by Electron in MV2 only); MV3 blockers require `declarativeNetRequest`, absent from Electron. Future option WITHOUT an extension: a blocker built into Mira (e.g. `@ghostery/adblocker-electron` on `session.webRequest`), possible precisely because we give up the extensions' webRequest (§3.1) |
| MV3 blockers (uBO Lite…)                                                            | ❌ today               | no DNR, and `chrome.webRequest` is unavailable in MV3 service workers (electron#52265, open)                                                                                                                                                                                                                                                                                         |
| Extensions requiring `chrome.identity` (OAuth), `sidePanel`, `tabGroups`, `commands` | ❌                     | implemented neither by Electron nor by the lib                                                                                                                                                                                                                                                                                                                                       |
| Password managers (1Password…)                                                      | 🔶 to test             | MV3 SWs run on Electron 41; autofill depends on APIs to validate for real — and `window.open` OAuth popups depend on D5 (§7)                                                                                                                                                                                                                                                         |

Sources: official doc [electronjs.org/docs/latest/api/extensions](https://www.electronjs.org/docs/latest/api/extensions)
(exact list of supported APIs, DNR absent);
[electron#52265](https://github.com/electron/electron/issues/52265) (open: `chrome.webRequest.onBeforeRequest`
undefined in MV3 SWs); [electron#49984](https://github.com/electron/electron/issues/49984)
(maintainer: "V3 Chrome extensions are supported. We just don't support all specific APIs
that Chrome provides."); [electron-browser-shell#172](https://github.com/samuelmaddock/electron-browser-shell/issues/172)
(MV3 SWs broken on Electron 40, working again in 41 — a user's bisection, not confirmed by an Electron changelog).

## 2. Building blocks chosen

Monorepo [samuelmaddock/electron-browser-shell](https://github.com/samuelmaddock/electron-browser-shell)
(the de facto reference, with uBlock Origin and Dark Reader showcased in the README):

| Package                        | Version | License                                                                                                                         | Role                                                                                                                                                  |
| ------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `electron-chrome-extensions`   | 4.9.0   | **GPL-3.0 or Patron (paid)** — `license` field **mandatory** in the constructor, checked at runtime (`checkLicense()` throws)     | Implements `chrome.tabs/windows/action/cookies/contextMenus/notifications/webNavigation/runtime/storage` on top of OUR tabs, via callbacks           |
| `electron-chrome-web-store`    | 0.13.0  | MIT                                                                                                                             | Direct install from chromewebstore.google.com: downloads/unpacks the `.crx` (CRX2/3), auto-update every 5 h, allowlist/denylist, `beforeInstall`      |
| `electron-chrome-context-menu` | 1.1.0   | MIT                                                                                                                             | Right-click menu at Chrome parity; accepts extension items via `extensionMenuItems`                                                                   |

Loading itself stays native Electron: `session.extensions.loadExtension`
(the `ses.loadExtension` form is **deprecated**), **persistent** sessions only,
after `app.ready`, to redo on **every boot**, unpacked folders only (the `.crx` is
the web-store package's business).

Integration constraints verified (README + lib source):

- **One `ElectronChromeExtensions` instance per session** (throws on duplicate). The lib registers
  its preload on the session itself (`registerPreloadScript`, frame + service-worker) —
  nothing to add to the tabs' `webPreferences`.
- The lib's preload **must be bundled at packaging** (`electron-chrome-extensions/preload`) —
  to validate in `build:mac` (electron-vite externalizes deps, electron-builder bundles them;
  otherwise a copy plugin, see README).
- MV3 SWs require the **sandbox enabled** on the tabs' webContents — that is the default,
  and Mira's tab views do not disable it (`materializeTab` in `profiles.ts`:
  `webPreferences` = partition only; the existing `sandbox: false` only concerns the chrome
  and Settings windows, not the views). Never add `sandbox: false` to tab views.
- "All background scripts are persistent" (lib limitation): every loaded extension costs
  its RAM continuously, multiplied by the number of sessions it is loaded in (visible in
  our RSS status bar).

## 3. Pitfalls specific to our architecture

1. **`session.webRequest` is mutually exclusive with the extensions' `chrome.webRequest`.** A single
   `session.webRequest.*` listener set by our code **silently disables** the extensions'
   `chrome.webRequest` on that session (Electron exclusivity rule, lib README:
   "Usage of Electron's webRequest API will prevent chrome.webRequest listeners from
   being called"). Since D3 took uBlock MV2 out of scope, this is no longer a critical
   safeguard — quite the opposite: the way is clear for a future blocker built into
   Mira. Good to know, not to test.
2. **Sessions per profile.** Each profile has its partition (`persist:mira-<id>`, default = default
   session — `partitionForId` in `profile-store.ts`). Since extensions are per session,
   the sets are naturally **per profile** (D2 decided): installing an extension =
   installing it in the current profile, and only that one. The default
   session is shared with the chrome and Settings windows (their `webPreferences` have no
   partition) — in dev, the chrome is `http://localhost`: an `<all_urls>` content script
   would inject into it. Accepted for now (in prod the chrome is `file://`, not matched by
   default), to revisit if it gets in the way (D4).
3. **`window.open` is denied everywhere.** `materializeTab` sets a `setWindowOpenHandler` that
   denies everything and routes to `shell.openExternal`. Consequences for extensions: the
   `target=_blank` links of an extension dashboard go to the system browser, a
   `window.open('chrome-extension://…')` fails silently (no macOS handler for that scheme),
   and an OAuth popup opened by a page never enters the Mira session. → Decision D5.

## 4. Architecture in Mira

Faithful to the two founding principles: everything goes through the registry, pure logic is tested.

### 4.1 `ExtensionsService` (main, new file `src/main/extensions.ts`)

Owns the lib instances and the wiring. **Map key = the `Session` object itself**,
resolved at the wiring point via `view.webContents.session` — never rebuilt from the
partition name (pitfall: `partitionForId('default')` returns `undefined`, and
`session.fromPartition(String(undefined))` would create an in-memory partition where `loadExtension`
throws). Default profile → `session.defaultSession`, explicitly. This keying also makes the
duplicate instance (the lib's throw) impossible by construction.

```ts
new ElectronChromeExtensions({
  license: 'GPL-3.0', // decision D1, see §7
  session,
  createTab: async (details) => {
    /* newTabIn of the right ProfileWindow → [webContents, window] */
  },
  selectTab: (wc, win) => {
    /* selectTabIn */
  },
  removeTab: (wc, win) => {
    /* closeTabIn */
  },
  createWindow: async (details) => {
    /* refused at first: one window = one profile (decision made) */
  }
})
```

(`assignTabDetails` deliberately left out: the lib only sees tabs that have a webContents,
so `discarded` would be constant there — dead logic.)

Wiring at the existing crossing points of `profiles.ts` (all unique choke points):

| Mira event                | Where (function)                                                                                                                                                                                                                                                                    | Lib call                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| tab webContents created   | `materializeTab` (the ONLY place a `WebContentsView` is created in all of `src/`)                                                                                                                                                                                                   | `extensions.addTab(wc, win)` |
| tab activated             | **everywhere `state.activeId` changes**: `newTabIn` (a new tab becomes active via the tab-store's `addTab` — the most frequent path, Cmd+T / open-bookmark / navigate-on-empty), `selectTabIn`, neighbor activated in `closeTabIn`, `restoreSession`, `discardActiveTabIn`         | `extensions.selectTab(wc)`   |
| tab closed                | `closeTabIn`                                                                                                                                                                                                                                                                        | `extensions.removeTab(wc)`   |
| tab put to sleep (discard)| `discardView`                                                                                                                                                                                                                                                                       | `extensions.removeTab(wc)`   |

Rather than 5 call sites, aim for **a single "activation changed" hook** called everywhere
`activeId` moves (including future cases such as a Settings tab without a webContents — signal
nothing to the lib when the active tab has no view).

Lifecycle when a profile **window** closes: an Electron `Session` is never
destroyed, so the lib instance and the persistent background scripts **stay in RAM** with the
window closed (visible in the status bar). Accepted in V1 ("warm sessions") and documented; if it
weighs too much, E6 will add unloading (`removeExtension` per extension on close, reload
on reopen).

Accepted quirk: **sleeping** tabs (lazy-load) have no webContents → invisible to
`chrome.tabs.query`. Consistent with `discarded`, harmless.

### 4.2 Command domain `src/main/commands/extensions.ts`

Standard pattern (model: `status.ts`): `ExtensionsContext` slice, exported pure helpers,
`extensionsCommands: CommandMap<CommandContext>`, `extensions.test.ts`, fakes in
`fake-context.ts`, stubs in the inline context of `socket.test.ts`. One line to touch in
`commands/index.ts` + the intersection in `commands/context.ts`.

Commands: `list-extensions`, `install-extension {id}` (Web Store), `load-extension {path}`
(unpacked/sideload), `uninstall-extension {id}`, `update-extensions`. All drivable through
socket/MCP — installing uBlock from a shell becomes one `nc` line.

Two points specified in advance (found in review):

- **Install/uninstall target the profile of the calling window** (D2: per-profile sets).
  The web-store package's API (`installExtension`/`uninstallExtension`) takes a session —
  exactly our granularity. The pitfall to test is isolation: two profiles = two
  independent installs (disk included); uninstalling in A must change NOTHING in B.
  Test: fake context with 2 profiles, uninstall in A, B intact.
- **`normalizeInput` (`url.ts`) must accept `chrome-extension://`.** Today its regex only
  knows `https?|file|about:` → a `navigate` to an extension page (socket/MCP or Enter
  in the bar mirroring an extension tab) would turn into a Google search. One line +
  its test in `url.test.ts` (E1).

### 4.3 Structural prerequisite: async registry (E0)

The registry is **synchronous** (`CommandHandler` returns `CommandResult`, `registry.ts`) but
`installExtension` & co are async. E0 widens the type to `CommandResult | Promise<CommandResult>`.
Actual scope (verified call site by call site):

- `ipcMain.handle` (IPC): nothing to do, it already awaits promises.
- Socket path: `handleRequestLine` (`socket.ts`) becomes async, and its try/catch must
  catch **rejections** (not only synchronous throws) → `fail()`.
- `socket.test.ts`: its synchronous assertions on `handleRequestLine` switch to `await` —
  the existing tests **must be edited**, they do not stay green as they are.
- Menu accelerators (`index.ts`/`menu.ts`): fire-and-forget; add a `.catch` so that
  an async command in error does not become an unhandled rejection.

Small but not cosmetic. To do first and alone (shared files `registry.ts` /
`socket.ts` — minimal collision with other sessions if the increment is short).

### 4.4 UI (React chrome)

- **Toolbar action buttons**: the lib provides the `<browser-action-list>` Web Component
  (badges, clicks, popups). Prerequisite: call `injectBrowserAction()` in **our chrome
  preload**, and `ElectronChromeExtensions.handleCRXProtocol(session)` to serve icons over
  `crx://`. **`partition` attribute mandatory**: the chrome of EVERY profile window runs
  on the default session, and the element binds by default to the session it lives in — without
  `partition="persist:mira-<id>"`, the "Work" window would display/drive the extensions of the
  default profile (silent, no error). Omit the attribute only for the default profile.
  To validate in E3: that `handleCRXProtocol` on the chrome's session does serve the icons of
  extensions loaded in another session (not documented by the lib).
- Component under `renderer/src/features/extensions/` (CLAUDE.md rule), mounted in the toolbar
  of `App.tsx` after the address `<form>`, dedicated CSS (not in `main.css`).
- **CSP to open up**: the chrome's CSP lives in the `<meta http-equiv>` tag of
  `src/renderer/index.html` (`img-src 'self' data:` — that is why favicons are
  letter badges) → add `crx:` to `img-src` there.
- **Extension popups**: the lib creates its **own frameless child window** (`PopupView`,
  auto-sized, closed on blur), anchored on the button rect sent by the chrome. That is
  exactly the workaround for pitfall #3 of `CLAUDE.md` (native window above web content),
  already proven by our tooltip → nothing to invent.
- **State**: the chrome stores nothing (existing principle). If we build our own UI later,
  push `mira:extensions-changed` + seed via `list-extensions`, like tabs.

### 4.5 Web Store, storage & boot order

`installChromeWebStore({ session, extensionsPath, minimumManifestVersion, beforeInstall, autoUpdate })`
per profile session. Extensions stored **per profile**
(`extensionsPath: userData/Extensions/<profileId>/` — D2; disk duplicated if two profiles
install the same extension, accepted), loaded into the profile's session when its
window opens (`loadAllExtensions`). `minimumManifestVersion` stays at the package default (3) — D3
gave up uBlock/MV2, no need to lower the floor (unpacked sideloading of an MV2 via
`load-extension` stays technically possible if ever useful).
`beforeInstall` → native confirmation dialog.

**Mandatory boot order**: `await loadAllExtensions(session)` **before** the window's
`restoreSession`. Otherwise a tab persisted on a `chrome-extension://` page (uBlock dashboard…)
is restored before the extension is registered → ERR_FAILED on relaunch. Explicit validation
case in E5: quit with an extension tab active, relaunch.

## 5. Increments (one feature = one test, each shippable alone)

- **E0 — Async registry.** Exact scope in §4.3 (widened type, async socket + catching
  rejections, editing `socket.test.ts`, `.catch` on menu accelerators). Tests: async
  command happy path + rejection → `{ok:false}` via the registry and via `handleRequestLine`.
- **E1 — Loading + `extensions` domain.** npm deps, `ExtensionsService` (map keyed by
  `Session`, §4.1), wiring of the choke points **including the single activation hook**,
  `load-extension`/`list-extensions`/`uninstall-extension` (multi-session, §4.2),
  `chrome-extension://` in `normalizeInput` + test, ordered loading at boot (§4.5).
  Tests: domain via registry + fake context (list, invalid params, install/uninstall
  isolation between profiles, unknown uninstall → `{ok:false}`); pure helpers
  (`ExtensionInfo` normalization).
  In-app validation: unpacked Dark Reader darkens a page.
- **E2 — Validation of real extensions (MV3).** Install and validate for real a small
  representative set: Dark Reader (content scripts + action), a clipper (Obsidian Web Clipper),
  a password manager (1Password — the 🔶 case of §1: MV3 SW, autofill, OAuth popup via D5).
  Record here what works/breaks — it is the real test of the "broad compat" promise
  since D3 took uBlock out of scope.
- **E3 — Toolbar actions + popups.** `injectBrowserAction` (preload), `<browser-action-list
partition=…>` (feature component, §4.4), `handleCRXProtocol`, CSP `crx:` in `index.html`.
  Validation: uBlock/Dark Reader popup anchored to the button, **in a non-default profile window**
  (the session-binding bug is silent — it is THE case to test).
- **E4 — Context menu.** `webContents.on('context-menu')` on tab views →
  `buildChromeContextMenu` + `extensions.getContextMenuItems(wc, params)`. Bonus: Mira gains
  a real Chrome-parity right-click (there is none today). Wiring in
  `materializeTab`, next to `wireView`.
- **E5 — Web Store.** `installChromeWebStore` per session, `install-extension {id}` +
  `update-extensions` in the registry, `beforeInstall` confirm. Validation: browse
  chromewebstore.google.com in Mira, install in one click, then quit/relaunch with a
  `chrome-extension://` tab active (§4.5).
- **E6 — Management + packaging.** Settings surface (list + uninstall, per profile — D2),
  `mira:extensions-changed` events, unloading when a window closes
  if the RAM of warm sessions weighs too much (§4.1), check of the lib preload in the packaged build
  (`build:mac`). Tests: pure per-profile state logic.

Order: E0 → E1 → E2 validate the core of the promise (real extensions run) before
any UI investment. If E2 breaks, we know as early as possible.

## 6. Known risks (sourced)

- **`chrome.commands` stubbed** (extension keyboard shortcuts inert); `chrome.tabs.move/duplicate/captureVisibleTab` ❌ — lib README table.
- **Cmd+S = Discard Tab in our app** (`menu.ts`): on any page where Cmd+S means
  "save" (Google Docs, extension options editors…), the menu accelerator wins:
  tab discarded, edits lost. Pre-existing, but extension pages make it more
  prominent. To move (Cmd+Shift+S?) before E2.
- **`storage.managed`/`sync` → `local` shim** (the lib redirects everything to `local`): an
  extension that writes a lot through these APIs can bloat `Local Extension Settings`
  (extreme case reported: [electron-browser-shell#158](https://github.com/samuelmaddock/electron-browser-shell/issues/158)). To watch (userData size).
- **Electron 41 not tested by the lib** (developed on 37, minimum 35, no upper bound). The lib follows
  Electron closely but can break on a version bump (precedent: #172 on Electron 40).
- **GPL-3.0 license checked at runtime** with a sha256 blocklist of non-compliant projects
  (the lib's `src/browser/license.ts`). Not a risk if D1 is accepted, but good to know.
- **Packaging of the lib preload** — to validate in E6 (precedent: we already have a frozen
  electron-builder patch, see CLAUDE.md Notes).

## 7. Decisions (all settled with the user, 2026-07-10)

- **D1 — License.** `license: 'GPL-3.0'`: free, requires providing the sources **if we
  distribute** Mira (no distribution planned today = not a problem). Alternative:
  GitHub sponsor → Patron license. **Recommendation: GPL-3.0. [SETTLED 2026-07-10: GPL-3.0 — no
  distribution planned.]**
- **D2 — Global or per-profile extensions?** **[SETTLED 2026-07-10: PER PROFILE** — profiles
  always stay separate. Supersedes the "global set" recommendation; carried over into §3.2, §4.2,
  §4.5, E1, E6.]
- **D3 — Allow MV2 (`minimumManifestVersion: 2`)?** It was the condition for ad-blocking
  by extension (full uBlock). **[SETTLED 2026-07-10: NO** — uBlock is not a goal.
  Accepted consequence: **no ad blocking by extension** in Mira (no MV3 blocker
  can block under Electron). Door left open: a blocker built into Mira via
  `session.webRequest`, made possible by this renunciation (§3.1).]
- **D4 — Chrome UI on the default session** (content-script risk in dev, §3.2).
  **Recommendation: accept**, revisit if a content script pollutes the chrome in dev.
  **[SETTLED 2026-07-10: accept.]**
- **D5 — `window.open`: route to a tab.** Today deny-all → external browser
  (§3.3). For a browser, the expected behavior is: `_blank`/`window.open` http(s) and
  `chrome-extension://` from the same session → **new Mira tab** (`newTabIn`). This changes an
  existing behavior (links that used to go to the system browser) and conditions the
  OAuth popups of password managers. **Recommendation: route to a tab, from E1 on.
  [SETTLED 2026-07-10: route to a tab.]**

## 8. E7 — Kondo does not run + filling in the missing `chrome.*` APIs (2026-07-11)

**✅ RESOLVED on the evening of 2026-07-11 — see §8.12 (the full resolution, standalone section).**
§8.11 = the recap of the investigation (root cause, refuted theories, options considered);
§8.1–8.10 = the chronological log kept as a trace, with intermediate states later
corrected (e.g. §8.8 "it converges" = FALSE, see §8.11-D) — rely on them ONLY through §8.11/§8.12.

### 8.1 The symptom

Kondo (`kojhnafkiednagnljfgakalcbfbklbdk`, v1.12.1) loads in Mira but shows, in a loop,
a "Browser extension stopped / Toggle it off and back on" dialog → reload → loops again.
Kondo = **two coupled pieces**: an **extension** (injects into LinkedIn) + a **web app**
`app.trykondo.com`. The dialog comes from the web app, which can no longer talk to the extension.

### 8.2 VERIFIED facts (with proof)

1. **The content script does inject.** Marker `<div id="kondo-ext" version=1.12.1 key=<id>>`
   present in `app.trykondo.com` (probed via `exec-js` with `tabId`). Rules out "new tab required"
   and "injection missing".
2. **The loop mechanism** (read in `assets/content-DQEAdWiS.js`, deobfuscated): the content
   script creates a `<div id=kondo-ext>` (closed shadow root) containing a **hidden iframe** →
   `chrome-extension://<id>/ext.html?session=X`; then opens a **long-lived Port**
   `chrome.runtime.connect({name:'kondo-content'})` to the SW; its `.onDisconnect` does
   `location.reload()`. The web app relays through the iframe/postMessage and, for lack of an answer from the SW,
   logs `Error: Extension bridge timeout | PopupConnectError` (repeated ~every 30 s).
3. **The `declarativeNetRequestWithHostAccess` permission causes a FATAL native binding failure.**
   The Chromium log prints `ERROR native_extension_bindings_system.cc:767] Failed to create API on
Chrome object` in a **dedicated process that logs ONLY that** (context dead at bindings
   creation, before any JS). **PROOF**: after removing `declarativeNetRequestWithHostAccess`
   - the `declarative_net_request` block from `manifest.json` and restarting, this error **DISAPPEARS**
     from the log, and `list-extensions` returns `gaps: []` (the edit did load). Electron does not compile
     `declarativeNetRequest` → declaring the permission is enough to crash the namespace creation.
     It is **the same error** that preceded the SIGSEGV of the Otto onboarding (track.md).
4. **BUT removing DNR is NOT enough: the loop persists.** Without the DNR permission, the Kondo SW
   produces **no log line at all** and `Extension bridge timeout` continues. The remaining blocker =
   the **content-script ↔ service worker bridge** (`chrome.runtime.connect`), which does not get established.
5. **Extension SW consoles ARE captured** in Mira's log (Dark Reader logs
   "Welcome to Dark Reader!" from `chrome-extension://…/background/index.js`). So the total **absence**
   of logs from the Kondo SW is significant: its SW **runs no JS** (not started, or dies
   before the console). Dark Reader (no DNR) runs, Kondo does not.
6. **Mira's service-worker preload does NOT run.** The `[mira-sw]` diagnostic injected into
   `ALARMS_POLYFILL_SOURCE` appears **nowhere** in the log — not even in the Dark
   Reader SW, which does run. So `ses.registerPreloadScript({type:'service-worker'})` does not inject
   into extension SWs in our setup → **Tier A is inoperative as is** (see §8.5 for the lead).
   Ref: the lib injects ITS preload through the same mechanism and guards it
   (`node_modules/electron-chrome-extensions/dist/chrome-extension-api.preload.js:594`,
   `process.type === "service-worker" || location.href.startsWith("chrome-extension://")`).

### 8.3 REFUTED theories (do not pick them up again)

- **"`chrome.alarms` missing → the SW throws": FALSE.** Kondo's SW does call `chrome.alarms`
  5× (grep in `background-vYAqPXIO.js`) and alarms is provided neither by the lib nor by Electron.
  BUT the process that dies logs **no** JS throw (it dies at the creation of the native
  bindings, not at JS runtime); and a throw on `chrome.alarms` would show up in the log like
  Dark Reader's throws. The trigger of the `Failed to create API` is **DNR** (proven §8.2.3), not
  alarms. A JS shim can do nothing against a native binding failure.
- **"new tab required" / "injection missing": FALSE** (§8.2.1).
- **"removing DNR fixes Kondo": FALSE** (§8.2.4 — removes the binding crash but not the loop).

### 8.4 State of the code (what exists, what works)

Files touched/created (master branch, uncommitted):

- **`src/main/extension-capabilities.ts`** (NEW, pure, **21 green tests** in
  `extension-capabilities.test.ts`):
  - `translateDnrRules` / `dnrUrlFilterToRegExp` / `dnrMatches` — DNR → `webRequest` plan.
  - `detectCapabilityGaps` / `PROVIDED_APIS` / `KNOWN_LIMITATIONS` — Tier C.
  - `ALARMS_POLYFILL_SOURCE` / `alarmDelayMs` / `alarmPeriodMs` — Tier A (inoperative, §8.2.6).
  - **⚠️ contains a TEMPORARY DIAGNOSTIC `[mira-sw]`** (console.log + error listeners) in
    `ALARMS_POLYFILL_SOURCE` — **to remove**.
- **`src/main/extensions.ts`** (native, edited): `registerAlarmsShim` (SW preload — inoperative),
  `applyDnr` → `session.webRequest` (Tier B, called on every load/enable/update/uninstall),
  `readManifest`/`readDnrRules`/`gapsFor`/`withGaps`. Module helpers `isDnrBlocked`/`pickDnrRedirect`/
  `applyRequestHeaderMods`/`applyResponseHeaderMods`. (NB: this file is also edited by other
  sessions — check `git diff` before editing it again.)
- **`src/main/commands/extensions.ts`**: `gaps?: CapabilityGap[]` field added to `ExtensionInfo`.

Status per tier:

- **Tier C (gaps) — WORKS FOR REAL.** `list-extensions` returns Kondo's `gaps`
  (`declarativeNetRequest*` degraded). That is the tool that should have guided us from the start.
- **Tier B (DNR→webRequest) — CODED, NOT VALIDATED FOR REAL.** Pure logic tested; the
  `session.webRequest` wiring could not be exercised (Kondo does not load). Sound on paper.
- **Tier A (alarms shim) — INOPERATIVE** (the SW preload does not run) **AND probably useless**
  (alarms was not the cause). Decision pending: fix the injection or remove it.

### 8.5 OPEN next steps (for the fresh session)

1. **Tier 0 first (cheap, could unblock everything)**: test a more recent version
   of `electron-chrome-extensions` (current **4.9.0**). The remaining blocker is the
   `chrome.runtime.connect` content-script ↔ MV3 SW bridge (wake-up + long-lived Port). Search the
   upstream issues (samuelmaddock/electron-browser-shell) for "service worker", "runtime.connect",
   "port", "MV3". Existing ref §1: electron#52265 (chrome.webRequest unavailable in MV3 SW, open).
2. **Name the faulty API for sure** (instead of inferring): relaunch with verbose Chromium
   logging — `app.commandLine.appendSwitch('vmodule','native_extension_bindings_system=2')` (before
   `app.ready`, in `index.ts`) → the log will name the API that `CreateAPIBinding` fails to create.
   Expected: it confirms `declarativeNetRequest`.
3. **Clean fix of the DNR crash (real general bug, not done)**: at **load**, remove the
   `declarativeNetRequest*` permission from the manifest (the SW no longer dies) BUT keep the
   `declarative_net_request` block (or read the ruleset first) so that **Tier B** applies the rules via
   `webRequest`. That would make ANY DNR extension viable — Kondo additionally keeps the bridge blocker (#1).
   Implies patching the manifest on disk at load (overwritten on updates → reapply), or loading
   a patched copy.
4. **Settle Tier A**: either understand why `registerPreloadScript({type:'service-worker'})`
   does not inject (order? the lib overwrites? extension SWs excluded?), or **remove Tier A** (+ the
   `[mira-sw]` diagnostic) as dead code.
5. **Remove the temporary `[mira-sw]` diagnostic** from `ALARMS_POLYFILL_SOURCE` in any case.

### 8.6 Debug toolbox (how to pick it up again — READ FIRST)

- **Mira runs under `npm run dev`** (long-running process — DO NOT launch/kill without the user's consent;
  a change to main relaunches main automatically). Control socket: `/tmp/mira.sock`,
  one JSON request per line: `printf '%s\n' '{"command":"...","params":{...}}' | nc -U /tmp/mira.sock`.
- **`exec-js` TAKES A `tabId`** (`src/main/commands/devtools.ts`) — **ALWAYS pass it** to target
  a precise tab by UUID (obtained via `list-tabs`). Without `tabId`, it hits the active tab of the
  frontmost window → fragile, the source of all my thrashing. `list-commands` lists the 76 commands.
- **Opening a `chrome-extension://…` page as a tab FAILS** (the `WebContentsView` does not
  materialize: "reading 'session'") — a separate bug, do not count on it to probe the extension
  context.
- **Logs**: `~/Library/Application Support/Mira/logs/chromium-<ts>.log` (rotating, 10 kept;
  `main-<ts>.log` for main). **Extension SW/content consoles show up there** (source
  `chrome-extension://…`). Useful greps: `bridge timeout`, `Failed to create API`, `[mira-sw]`,
  `kojhnaf`, `getExtensionStatus`.
- **Kondo internals on disk**: `~/Library/Application Support/Mira/Extensions/default/kojhnafkiednagnljfgakalcbfbklbdk/1.12.1_0/` —
  `manifest.json` (permissions + `declarative_net_request` → `ruleset.json`);
  `assets/content-loader.js` → `content-DQEAdWiS.js` (THE BRIDGE: `ext.html` iframe + `runtime.connect`);
  `service-worker-loader.js` → `background-vYAqPXIO.js` (the SW; usage: `alarms` 5×, `cookies` 12×,
  `notifications` 10×, `storage` 15×, `contextMenus` 4×, **`declarativeNetRequest` 0×**);
  `ruleset.json` (a `modifyHeaders` that removes `Origin` on `https://www.linkedin.com/*` XHR — Kondo's
  CORS workaround to read LinkedIn).
- **Manifest experiment (reversible)**: back up `manifest.json` → remove
  `declarativeNetRequestWithHostAccess` + the `declarative_net_request` block → restart dev → the
  `Failed to create API` error disappears (but the loop persists). Restore from the backup afterwards.
- **Missing ground truth**: the exact cause of the SW's non-answer. Since we could neither run
  JS in the SW (my preload does not inject) nor open an extension page, what remains is to get either the
  SW's DevTools, or the verbose log (§8.5.2).

### 8.7 Session 2026-07-11 afternoon — ROOT CAUSE FOUND, fixes coded, to validate

**⚠️ This section SUPERSEDES §8.2.4/8.2.5/8.2.6, §8.3 (partially) and §8.5.** Three stacked
causes, all proven, three fixes coded (green tests, typecheck OK) — **not yet validated
for real** (a restart of `npm run dev` is needed).

#### The three causes (full chain of the "Browser extension stopped")

1. **DNR permission → native bindings crash** (already proven §8.2.3, unchanged). Declaring
   `declarativeNetRequestWithHostAccess` is enough to kill the SW before any JS.
2. **`chrome.alarms` does not exist → top-level throw at the END of the SW module.** The official
   Electron 41 doc (`docs/api/extensions.md`, branch 41-x-y) lists the supported APIs: alarms is NOT
   there (runtime.connect/onConnect are). The tail of Kondo's SW bundle is
   `…onConnect.addListener(f), onInstalled.addListener(fe), onStartup.addListener(_), _(), …(W), W(), …(X), X()`
   and `X()` does `chrome.alarms.onAlarm.removeListener(Z)` → TypeError. onConnect is registered
   BEFORE the throw, but a failed SW module evaluation marks the worker as broken on the Chromium side.
   **Correction of §8.3**: "alarms is the cause" had been wrongly refuted — the argument "the throw
   would show up in the log" does not hold (the console of a SW whose evaluation fails is not captured),
   and "the SW produces no log" (§8.2.5) was an artifact: Kondo's SW has only ONE console.*
   in all its code. **Proof that it runs**: at enable (12:47:59), the debug logs of the lib's
   preload (`contextMenus.create` ×2, lines :49/:67 of the preload) appeared — the SW runs JS
   without DNR. §8.2.4 ("SW silent without DNR") is therefore FALSE.
3. **Electron 41 never (re)starts an extension's SW beyond the first launch, and
   `chrome.runtime.connect` does NOT wake up a stopped worker.** This is **electron#41613**, fixed on
   main (merged 2026-04-02, PR #50611) and backported to **42.x** (#50640); the 41-x-y backport
   (#50641) was **abandoned** ("workaround exists"). Mechanism of the fix: Electron resets
   `kPrefHasStartedServiceWorker=false` on every load to re-trigger Chromium's fresh-install
   logic. **Local proofs**: (a) reload of the Kondo tab at 12:55:59 → web app banner at
   12:56:00 → `Extension bridge timeout` at 12:56:02, while the SW was dead; (b) `ps`: NO
   Mira process with `--extension-process` (the SW was not woken up by the connect); (c) Kondo's SW
   registration does exist in the `Service Worker/Database` LevelDB (registration
   is not the problem, starting is). **Official workaround** (issue #41613, comment 2644018998): `session.serviceWorkers.startWorkerForScope(extension.url)` after the load.

#### Corrections of earlier observations

- **§8.2.6 ("the SW preload does not run"): FALSE, misread.** In the shim of the time, the guard
  `if (!g.chrome || !g.chrome.runtime) return;` was placed BEFORE the `[mira-sw]` diagnostic. But a
  SW preload runs in the **isolated world** (context isolation) where `globalThis.chrome` does not exist →
  the guard exited before logging. The lib's preload, on the other hand, works because it goes through
  `contextBridge.executeInMainWorld` (see `chrome-extension-api.preload.js`) — and it ends with
  **`Object.freeze(chrome)`** in the main world: any shim that runs AFTER it can no longer
  add anything to `chrome` (assignment silently ignored).
- **Tier 0 (more recent lib): dead end.** 4.9.0 = latest npm version AND latest commit of the upstream
  repo (2025-07-02, HEAD = release 4.9.0). Nothing to recover.
- The `[mira-sw]` diagnostic was removed from `ALARMS_POLYFILL_SOURCE` (§8.5.5 done).

#### The three fixes coded (uncommitted, not validated for real)

1. **Strip DNR at load** (`extensions.ts`): `sanitizeExtensionDir` (backup of the original manifest as
   `manifest.mira-original.json` + rewrite without `declarativeNetRequest*` nor the
   `declarative_net_request` block), called on ALL loading paths (`sanitizeStoreDir` before
   `installChromeWebStore`, sideloads, `load`, `enable`, post-`installFromStore` with reload,
   post-`update` with reload). `readManifest` prefers the backup → Tier B (webRequest) and Tier C
   (gaps) always read the ORIGINAL manifest. Pure logic: `stripUnsupportedPermissions`
   (`extension-capabilities.ts`, tested).
2. **Alarms shim v2** (`extension-capabilities.ts`): split into `ALARMS_POLYFILL_MAIN_WORLD`
   (standalone function, tested) + an `ALARMS_POLYFILL_SOURCE` wrapper that gates on
   `process.type === 'service-worker'` and injects via `contextBridge.executeInMainWorld`. Registered
   **BEFORE** the construction of `ElectronChromeExtensions` (preload execution order =
   registration order) to precede the lib's `Object.freeze(chrome)`.
3. **Launch + keepalive of extension SWs** (`extensions.ts`): `launchWorkers` (the official
   workaround — `startWorkerForScope` for every MV3 extension with a SW, on all load paths) +
   `hookWorkerKeepalive` (versionId→scope map on `running-status-changed`; on `stopped`, restart
   if the extension is still loaded, throttled by `recordWorkerRestart` — pure, tested: max 5
   restarts/60 s so as not to loop on a SW that crashes at evaluation). Effect: extension SWs
   stay resident (RAM cost accepted, personal browser).

Test state: `npm run typecheck` OK, 557 green tests (46 files). Kondo's manifest on disk
**restored to the original** (the strip pipeline will redo it cleanly at boot). Temporary
instrumentation still in place for validation: `sw-debug.ts` (+ call in `ensureFor`) and the
`vmodule` switch in `index.ts` — **to remove after validation**.

#### Validation (blocked on a restart of `npm run dev` — user's consent required)

`electron-vite dev` without `-w` does NOT watch main (verified in the installed CLI: the watch option
exists but is not passed) — the §8.6 note "a change to main relaunches main" was wrong.
After restart, check in `main-<ts>.log`: (1) `[mira] stripped unsupported permissions from …`
(strip at boot); (2) `[sw-debug] … probe OK kojhnaf…` (the SW starts); (3) `[sw-debug] … status …
running` then stop/restart cycles; (4) NO MORE `Failed to create API` in `chromium-<ts>.log`;
(5) app.trykondo.com tab: no more `Extension bridge timeout` after the boot banner, no more
"Browser extension stopped" dialog. Then remove sw-debug + vmodule.

#### Side bugs

- **`exec-js` hangs on ALL tabs — CAUSE FOUND + FIX CODED (to validate at the next restart).**
  `webContents.executeJavaScript` NEVER resolves when a CDP debugger is attached to the same
  target — and `stealth.ts` attaches one on EVERY content view (`wc.debugger.attach('1.3')` for
  `Page.addScriptToEvaluateOnNewDocument`). Both share the DevTools transport. **Not an
  E7 regression**: the call `view.webContents.executeJavaScript(code, true)` is identical in the
  committed build (`git show HEAD:…profiles.ts`), so exec-js never returned a value in this
  environment (the §8.6 note "exec-js works" was overstated: never verified on a real
  return value). Proof of the hang: empty socket response (len=0 ⇒ no write ⇒ promise never
  settled); stealth did not see it because it does `.catch(()=>{})` on its reassert
  `executeJavaScript` calls (the real work goes through CDP `addScriptToEvaluateOnNewDocument`). **Fix**: new
  `src/main/cdp-eval.ts` — `evalInWebContents(wc, code)` routes through `wc.debugger.sendCommand(
'Runtime.evaluate', {returnByValue, awaitPromise, userGesture, replMode})` when a debugger is
  attached, otherwise falls back to `executeJavaScript`; pure logic `interpretRuntimeEvaluate` (7 tests).
  `execJsInTab` (profiles.ts, 2 call sites) calls it. Safe even if the hypothesis is partial:
  Runtime.evaluate also works when executeJavaScript works. **TO VALIDATE** at restart: `exec-js`
  must return a value (`document.title`, etc.). Same latent cause not fixed: skill
  extraction (`profiles.ts` ~2365, `executeJavaScript(extractionScript…)`) — to migrate onto
  `evalInWebContents` if run-skill hangs.
- **`Electron sandboxed_renderer.bundle.js script failed to run` + `TypeError: object null is not
iterable`**: **NOT our bug, upstream, benign.** Appears only once extensions are
  loaded (0 occurrences in the 23:56 run before installing Kondo), on pages THAT HAVE THEIR OWN
  service worker (several sites that register one, Kondo's own `sw.js` included). Cause: as soon as an
  extension is active, `electron-chrome-extensions` registers a `type:'service-worker'` preload
  (`crx-mv3-preload`) that applies to ALL SWs of the session, including those of web pages; under
  `--enable-sandbox`, the `sandbox_bundle` bootstrap of such a context iterates a null-ish preload
  list and throws. Independent of our alarms shim (the error predates its v2). The pages
  stay functional (the Chromium log says so itself: "recoverable / site still functional").
  No fix on the Mira side without patching Electron/the lib (the `registerPreloadScript` API has no
  per-scope filter). Historical ticket for the symptom: electron#32133. Leave as is.
- Useful detail: `list-extensions` (socket) targets the profile of the FOCUSED WINDOW — an empty list can
  just mean "wrong window" (go through `open-profile` first).

### 8.8 Session 2026-07-11 late afternoon — Kondo seems to CONVERGE, exec-js remains the blocker

**Log in progress, to complete.** Two builds restarted by the user this afternoon (14:57, then 15:26
with the CDP exec-js fix). New VERIFIED facts (logs read):

- **Kondo no longer loops — it converges.** Build 15:26 (`chromium-2026-07-11T15-26-22.log`): the web
  app reloaded **exactly 3 times** at boot (`build.260710` banners at 15:26:23 / 15:26:36 /
  15:26:47, each followed ~3 s later by an `Extension bridge timeout` at 15:26:26 / 15:26:39 /
  15:26:50) **then NOTHING MORE for 6+ min**. The Kondo SW (versionId=26) reaches `running` at
  15:26:22 and `probe OK` at 15:26:30, with no stop/start transition afterwards. **Reading**: the 3
  reloads = the startup race (the content script tries `connect` before the SW is warm);
  once the SW is stable (kept alive by the keepalive), the bridge is established and Kondo stops reloading.
  **To confirm visually** (has the "stopped" dialog disappeared from the screen?) — blocked by
  exec-js.
- **exec-js stays broken even via CDP.** The `cdp-eval.ts` fix (routes through the attached debugger's
  `Runtime.evaluate`, otherwise `executeJavaScript`) **is in the running build** (verified:
  `out/main/index.js` contains `evalInWebContents`/`Runtime.evaluate`, mtime 15:26:22), and yet
  `exec-js` still returns an EMPTY socket response (0 bytes ⇒ never a write ⇒ promise never
  settled), on all tabs, including the active tab and example.com. `get-status` answers ⇒
  socket healthy. So **BOTH paths (executeJavaScript AND Runtime.evaluate) never
  resolve** — it goes deeper than "the debugger blocks executeJavaScript".
- **New exec-js hypothesis (frozen renderer)**: inactive tabs are `view.setVisible(false)`
  (in `layout()` of `profiles.ts`) and `backgroundThrottling` is configured NOWHERE (`grep`
  empty) ⇒ default `true`. A hidden `WebContentsView` + a Mira window not in the foreground (the terminal has
  focus when I drive through the socket) ⇒ Chromium can occlude/freeze the renderer, and a frozen renderer
  makes `executeJavaScript` hang as well as `Runtime.evaluate`. To test: exec-js on the
  ACTIVE tab with the Mira window IN THE FOREGROUND, and/or set `backgroundThrottling:false` on the
  content views (`materializeTab()` in `profiles.ts`). NB: `exec-js` is **not** an
  E7 regression — the call
  `view.webContents.executeJavaScript(code, true)` is identical in the committed build
  (`git show HEAD:…profiles.ts`), so it never returned a value in this environment.
- **Instrumentation ready (not loaded)**: `cdp-eval.ts` was enriched with a `withTimeout` (5 s, no
  hang possible anymore) + `[cdp-eval]` logs per path (attached? cdp OK/FAILED, execJS OK/FAILED).
  The next restart will say EXACTLY which path fails and why.
- **Multi-agent investigation launched** (workflow `kondo-execjs-rootcause`): 5 parallel
  investigators on (1) exec-js, (2) the Kondo `ext.html` iframe/Port bridge, (3) the lib's Port
  routing, (4) the SW keepalive, (5) the log timeline; then adversarial verification + synthesis.
  Results to report here.
- **Under-explored bridge lead**: the Kondo bridge is NOT just `runtime.connect`. The content script
  creates a **hidden iframe** `chrome-extension://<id>/ext.html?session=X` (in a closed shadow root)
  and relays via `postMessage`/`MessagePort`. An earlier build (14:57) showed
  `ext.html … ERR_BLOCKED_BY_CLIENT` (framing an extension page inside a web page requires
  `web_accessible_resources` + Electron honoring it for SUB-FRAMES). The 15:26 build NO LONGER has this
  block (0 occurrences) — to correlate with the convergence. Check whether the iframe does load.

### 8.9 Session 2026-07-11 evening — TWO false beliefs demolished, Kondo bug isolated to the nested iframe bridge

**Major breakthrough via multi-agent investigation (workflow `kondo-execjs-rootcause`) + live tests.**
Two honesty corrections first:

1. **exec-js was NEVER broken — it was the `nc` client.** macOS `nc -U` does not read the response
   from the unix socket (it closes after the `printf`/EOF). A **raw Python socket** client gets the
   responses perfectly: `exec-js {code:'1+1'}` → `{"ok":true,"result":2}` in 0.00 s; DOM reads
   OK. **The whole "exec-js hangs, CDP is needed" story** of §8.7/§8.8 rested on a faulty test
   tool. The historical note "exec-js works, pass a tabId" was RIGHT; I was wrong to
   doubt it. The `cdp-eval.ts` fix (routes through Runtime.evaluate) was therefore not needed for a bug,
   but it is in place and works (to keep or simplify; it is hardening, not a fix). Driving
   tool from now on: Python helper `scratchpad/mira.py` (`call`/`execjs`), NOT `nc`.
   Verified nuance: exec-js does NOT await promises in the running build (`Promise.resolve(42)`
   → `{}`) — work around it with the pattern "start the async work, store it in `window.__x`, read it back synchronously".

2. **Kondo is STILL broken — my "it converges after 3 reloads" from §8.8 was FALSE.** Direct DOM
   probe of `app.trykondo.com`: `stoppedDialog: true`, text "Browser extension stopped / Toggle
   it off and back on". The SW-start race was refuted by the workflow (the extension SW was up
   the whole time); the 3 reloads then silence = the web app exhausted its retry budget, NOT a
   successful connection.

**The Kondo bridge (exact mechanism, read in the code):** a **4-hop** relay with MessagePort
transfer — web app → (window.postMessage) content script → (iframe.contentWindow.postMessage)
**hidden `ext.html` iframe** (chrome-extension://, in a closed shadow root) → (navigator.
serviceWorker) **extension SW**. The SW (`de` in `background-vYAqPXIO.js`) answers
`{source:'kondo-worker', status:'connected'}` on the port; `ext.html` (`settings.js`) does
`(await navigator.serviceWorker.ready).active.postMessage({source:'kondo-iframe'}, [...ports])`.

**What WORKS (proven live, each brick in isolation):**

- Content script injected (`#kondo-ext` v1.12.1 marker present).
- `ext.html` now loads as a tab AND as an iframe (no more `ERR_BLOCKED_BY_CLIENT`).
- In a **top-level tab** `chrome-extension://…/ext.html`: `navigator.serviceWorker.controller`
  = the extension SW, `getRegistrations()` = 1 (extension scope, state **activated**),
  `navigator.serviceWorker.ready` **resolves**. → refutes the hypothesis "navigator.serviceWorker
  unavailable in an extension page".
- The full handshake `ext.html(top-level) → active.postMessage(port) → SW de() → reply`:
  **`gotReply:true`, reply `{status:'connected'}`**. So the SW is healthy, `de` works, the alarms shim works
  (the SW does not throw at top level → `chrome.alarms` does exist = **alarms fix validated**).
- `chrome.runtime.connect({name:'kondo-content'})` from an extension page: port **stays
  connected** (no disconnect) → native runtime messaging OK.

**What BREAKS (reproduced live, robust over 8 retries):** replaying the web app's role FROM
`app.trykondo.com` — create a **nested `ext.html` iframe** (chrome-extension:// in the https
page), post `session` + MessagePort → **NO answer from the SW** (`gotReply` absent). Same
handshake, the only difference = **the iframe is nested in an https page** instead of a top-level
tab. **So the blocker is the `chrome-extension://` boundary nested inside a web page**:
either the MessagePort does not cross `iframe.contentWindow.postMessage` to the extension iframe, or
`navigator.serviceWorker` does not point to the extension SW in a nested iframe (maybe
wrongly scoped to the top-level trykondo origin, or SW disabled in a "third-party" context).

**Decisive step in progress**: `[mira-sw-msg]` logger added in the SW via the alarms preload
(`ALARMS_POLYFILL_MAIN_WORLD`, `extension-capabilities.ts`) to see whether the
`source:'kondo-iframe'` message **reaches the SW** in the nested case. Expected verdict:

- message does NOT REACH the SW ⇒ the port/message does not cross the nested iframe boundary
  (MessagePort transfer, or navigator.serviceWorker broken in the iframe) — likely an Electron
  41 limit; fix lead = upgrade to **Electron 42** (which already fixed #41613) or a Mira shim.
- message REACHES the SW but no reply ⇒ the return port does not come back — same class.
  Requires a restart of `npm run dev` (electron-vite does not watch main). **Refuted hypotheses
  not to pick up again**: "exec-js broken" (it was nc); "navigator.serviceWorker unavailable in an
  extension page" (works at top level); "SW dead / alarms throws" (the SW answers); "it converges on
  its own" (stopped dialog displayed).

### 8.10 DEFINITIVE ROOT CAUSE — extension SW unreachable from a nested iframe

**Proven unambiguously** (build 16:03, `[mira-sw-msg]` logger in the SW + a test mini-extension
that I control, `scratchpad/sw-probe-ext`, loaded via `load-extension`):

A `chrome-extension://` page **in a top-level tab** sees its service worker perfectly:
`navigator.serviceWorker.controller` = the SW, `getRegistrations()` = 1 (state activated), `ready`
resolves; the handshake `active.postMessage({source:'kondo-iframe'}, [port])` → SW `de()` → reply
`{status:'connected'}` **works** (also validated by the SW logger, which sees the message).

The **same page as an iframe nested in a web page** (Kondo's real case:
`chrome-extension://…/ext.html` inside `https://app.trykondo.com`) is cut off from its SW:

- `navigator.serviceWorker.controller` = **null**
- `getRegistrations()` = **[]**, `getRegistration()` = **null**
- `navigator.serviceWorker.ready` = **never resolves** (hang)
- BUT the `window.postMessage` + the **MessagePort do arrive** in the iframe (`received, ports:1`)
  → the web app → content script → iframe relay works; only the last iframe→SW hop is dead.

**Consequence**: the `kondo-iframe` message **never reaches the SW** in the real flow (SW logger =
0, while it catches the top-level case perfectly → logger validated). The SW answers "connected"
only if it is reached, which a nested iframe cannot do. Hence the permanent "Browser
extension stopped" dialog.

**It is neither a Kondo bug nor a Mira bug**: Kondo works in Chrome (where a
`web_accessible_resources` iframe is an extension context controlled by the SW). It is a **gap
in Electron/electron-chrome-extensions**: the extension SW is not attached to extension
sub-frames nested in a web page (probably a process/site-isolation issue). Confirmed
upstream: **electron-browser-shell#172 (open)** — "MV3 service workers broken", 1Password and
Obsidian Web Clipper give "popups with infinite loading states" (same symptom). Class
of extensions affected = all those that use the iframe-WAR → SW bridge via
`navigator.serviceWorker` (a common pattern in password managers / clippers).

**What is validated and works (not to reopen)**: DNR strip (SW no longer crashes), `chrome.alarms`
shim (the SW runs and answers → alarms present), SW keepalive (extension SW stable, 0
cycles), exec-js (never broken — it was `nc`, see CLAUDE.md), `chrome.runtime.connect`
extension-page→SW.

**Fix leads (decision to make):**

1. **Upgrade Electron 41 → 42+**: 42 fixed the extension SW lifecycle (#41613); to
   check whether it also attaches the SW to sub-frames. Risk: packaging (frozen app-builder patch),
   regressions. The "cleanest" if it fixes it natively.
2. **Mira "navigator.serviceWorker ↔ chrome.runtime" shim in extension pages**: hop (a)
   works (port in the iframe) and `chrome.runtime` reaches the SW → we can bridge. TWO sides
   must be patched: (page) replace `navigator.serviceWorker.ready.active.postMessage(msg,[port])` with
   a bridge that opens `chrome.runtime.connect` to the SW and relays; (SW, via the existing alarms
   preload) receive this `onConnect`, build a `MessageChannel` and **dispatch a synthetic
   `MessageEvent('message')` with a real MessagePort** on `self` so that Kondo's `de()`
   receives it. Self-contained and generic (not Kondo-specific), but not trivial; **one
   unproven piece** = the synthetic port dispatch on the SW side. `chrome.runtime` does NOT transfer
   MessagePorts, hence the double bridge.
3. **Accept** that this class of extensions (iframe→SW bridge) does not work on Electron 41.

Debug artifacts in place: `[mira-sw-msg]` logger in `ALARMS_POLYFILL_MAIN_WORLD`
(`extension-capabilities.ts`, temporary), `sw-debug.ts` + `vmodule` switch (`index.ts`),
mini-extension `scratchpad/sw-probe-ext` (uninstalled). Driving helper: `scratchpad/mira.py`.

### 8.11 FULL RECAP — everything that was done, tried, and what remains

_Standalone section: it reads on its own. §8.1–8.10 = the detailed log (with my mistakes and their
corrections); here = the reference synthesis. All the facts below were VERIFIED live on
2026-07-11 (Python socket client `scratchpad/mira.py`, `[mira-sw-msg]` logger in the SW, and a
test mini-extension `scratchpad/sw-probe-ext` that I fully control)._

#### A. The problem in one sentence

Kondo (extension + web app `app.trykondo.com`) permanently shows "Browser extension stopped"
because the last hop of its bridge — the `ext.html` page (a `chrome-extension://` page loaded as a
**nested iframe** in the web page) must reach its own service worker via
`navigator.serviceWorker` — is **dead in Electron**: an extension iframe nested in a
web page is not attached to its extension's SW.

#### B. Debug methodology (how to reproduce / pick up again)

- **Drive the socket ONLY through `scratchpad/mira.py`** (raw socket client), NEVER `nc -U`
  (see CLAUDE.md: `nc` misses asynchronous responses → false "empty"). `call({...})`,
  `execjs(tabId, code)`.
- **`exec-js` does not await promises** in the build: pattern "start the async work, store it in
  `window.__x`, read it back synchronously" on a 2nd call.
- **Observing the SW**: impossible via exec-js (tabs only). Solution = **a logger in the SW**
  via the alarms preload (`ALARMS_POLYFILL_MAIN_WORLD` → `console.log('[mira-sw-msg]'…)`); SW
  consoles show up in `userData/logs/main-<ts>.log`.
- **Separating the hops** = load a **test mini-extension** (`load-extension`) that reproduces
  Kondo's pattern but **reports each step to the parent** via `parent.postMessage` (works around the
  fact that we cannot script inside a cross-origin extension page). Model in
  `scratchpad/sw-probe-ext/` (MV3 manifest + `sw.js` + `probe.html`/`probe.js`).

#### C. What was TESTED, and the result (the real "what I tried")

| #   | Test (live)                                                                                              | Result                                                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `exec-js` via `nc -U` vs Python client                                                                   | nc → **0 bytes** (false hang); Python → **works**. The bug was the tool, not exec-js.                                                                |
| 2   | DOM probe of `app.trykondo.com`                                                                          | `stoppedDialog: true` — Kondo really broken (refutes "it converges").                                                                                |
| 3   | **Top-level** `ext.html` tab: `navigator.serviceWorker`                                                  | `controller` = the SW, `getRegistrations()` = 1 (**activated**), `ready` **resolves**.                                                               |
| 4   | Top-level tab: handshake `active.postMessage({source:'kondo-iframe'},[port])` → SW                       | **`gotReply:true`**, reply `{source:'kondo-worker',status:'connected'}`.                                                                             |
| 5   | SW logger during test #4                                                                                 | `[mira-sw-msg] source=kondo-iframe ports=1` → **logger validated** (it does see a real message).                                                     |
| 6   | `chrome.runtime.connect({name:'kondo-content'})` from `ext.html` → SW                                    | port **stays connected** (no disconnect) → native runtime messaging OK.                                                                              |
| 7   | Reload the **real Kondo** + SW logger                                                                    | **0** `kondo-iframe` received by the SW (while the logger works, #5) → the message never reaches the SW.                                             |
| 8   | From `app.trykondo.com`, create a **nested `ext.html` iframe** + post session+port (6–8 attempts)        | **no answer**; SW logger delta = **0**. Reproduces the bug outside Kondo's code.                                                                     |
| 9   | **Test mini-extension**, nested iframe, per-step report                                                  | `received: ports:1` (the port DOES ARRIVE in the iframe) BUT `controller:null`, `getRegistrations():[]`, `getRegistration():null`, `ready`: **timeout**. |
| 10  | Mini-extension, SW: dispatch of a **synthetic `MessageEvent` with a real MessagePort** on `self`         | `SELF-MESSAGE … portOk=true` then `SYNTHETIC-OK reply=…` → **the SW half of the shim works**.                                                        |

#### D. REFUTED theories (NEVER reopen)

- "Missing `chrome.alarms` makes the SW throw" — **real cause at first** but **fixed** (alarms
  shim); the SW runs and answers (#4).
- "The DNR permission crashes the SW" — **true**, but **fixed** (strip at load); no more
  `Failed to create API`.
- "Electron 41 does not restart the SW (#41613)" — **true**, **fixed** (keepalive
  `startWorkerForScope` + restart-on-stop); the extension SW is stable, 0 cycles (#7).
- "exec-js is broken / CDP is needed" — **FALSE**, it was `nc` (#1). The `cdp-eval.ts` fix is
  hardening, not a bug fix.
- "`navigator.serviceWorker` unavailable in an extension **page**" — **FALSE**, works at
  top level (#3).
- "It converges on its own after 3 reloads" — **FALSE** (#2, #7): the web app exhausts its retries.
- "The SW-start race explains the reloads" — **refuted** (the SW was up before the reloads).
- "The keepalive causes Port churn" — **refuted** (extension SW stable).
- "`ext.html` blocked `ERR_BLOCKED_BY_CLIENT`" — **was true** in an earlier build,
  **no longer the case** (the iframe loads).

#### E. What is PROVEN and SETTLED (works — do not re-test)

DNR strip · `chrome.alarms` shim · SW keepalive · `chrome.runtime.connect` page→SW · exec-js (via
Python client) · web app → content script → iframe relay (the port arrives in the iframe, #9).

#### F. THE ROOT CAUSE (definitive, #9)

A `chrome-extension://` iframe **nested in a web page** is **cut off from its extension's
service worker**: `controller` null, `getRegistrations()` empty, `ready` never resolves. In a
top-level tab, everything works (#3). The message + the MessagePort do arrive in the iframe (#9), so only
the iframe→SW hop is dead. Kondo works in Chrome (the WAR iframe is controlled by the SW there) ⇒ it is
a **gap in Electron/electron-chrome-extensions** (SW↔extension sub-frame attachment),
probably related to the process model / site isolation. **Entire class affected** (iframe→SW bridge
via `navigator.serviceWorker`): password managers, clippers. Confirmed upstream:
**electron-browser-shell#172 (open)** — 1Password / Obsidian Web Clipper, "popups with infinite
loading states" (same symptom).

#### G. REMAINING SOLUTIONS (detailed)

**Option 1 — Mira `navigator.serviceWorker ↔ chrome.runtime` shim (recommended; all bricks
proven #6, #9, #10).** Goal: make the iframe→SW hop work in extension pages, in a
**generic** way (unblocks the whole class, not just Kondo). Two halves:

- _Page (frame preload on `chrome-extension://` pages, to register via
  `ses.registerPreloadScript({type:'frame', …})`, gate `location.href.startsWith('chrome-extension://')`,
  and only when `navigator.serviceWorker.controller===null` = broken nested context)_:
  patch `navigator.serviceWorker.ready` to resolve to an object whose
  `.active.postMessage(msg, [port])`: opens `chrome.runtime.connect({name:'__mira_swbridge'})`,
  sends `msg` (JSON), and **relays the data** `port ↔ runtimePort` (JSON in both directions —
  Kondo only exchanges JSON: `{source:'kondo-worker',status:'connected'}`, etc.).
- _SW (addition to my existing alarms preload)_: on `chrome.runtime.onConnect` name `__mira_swbridge`,
  create a `MessageChannel(a,b)`, **dispatch `self.dispatchEvent(new MessageEvent('message',
{data: msg, ports:[b]}))`** (proven #10 → Kondo's `de()` receives a real port), and relay
  `a ↔ runtimePort`.
- **The MessagePort NEVER travels through `chrome.runtime`** (which cannot transfer it): each
  side builds its own local pair, only the data is relayed. That is the key that makes the shim
  possible.
- Points of attention: only patch extension pages whose `controller` is null (do not break the
  real `navigator.serviceWorker` where it works); handle several concurrent bridges (one pair per
  `postMessage`); handle disconnect/close on both sides; Kondo's `?session=` stays handled by its
  own code (we intercept lower down, at `active.postMessage`). Not trivial but bounded and testable
  (mini-extension + SW logger in place).

**Option 2 — Upgrade Electron 41 → 42+.** Electron 42 fixed the extension SW lifecycle
(#41613, not backported to 41). TO CHECK: does it also fix the SW↔sub-frame attachment (the
cause in §F)? If so, the shim is useless, it is the cleanest. How to test: bump `electron` to `^42`
in `package.json`, `npm i`, check that the frozen `app-builder-lib` patch still applies
(`patches/`, see CLAUDE.md Notes), relaunch, then replay test #9 (nested mini-extension:
`controller` must become non-null). Risks: Chromium 138→140 regressions, packaging.

**Option 3 — Fork/patch `electron-chrome-extensions`** to attach the SW to sub-frames
(via `patch-package`, like the existing app-builder patch). Deeper than the shim, depends on the
lib's internals; to keep for when options 1 and 2 fail.

**Option 4 — Accept** that this class (iframe→SW bridge) does not work on Electron 41 and
document it as a known limit (consistent with §1: "ceiling that comes from Electron").

#### H. Debug tooling IN PLACE (to remove once the route is decided)

- `[mira-sw-msg]` logger in `ALARMS_POLYFILL_MAIN_WORLD` (`extension-capabilities.ts`).
- `sw-debug.ts` (+ call in `ExtensionsService.ensureFor`) and the `vmodule` switch in `index.ts`.
- `cdp-eval.ts` (+ test): keep (exec-js hardening under a CDP debugger) or simplify — not a
  bug fix.
- Driving helper `scratchpad/mira.py` and mini-extension model `scratchpad/sw-probe-ext/`
  (outside the repo, session-scoped — recreate if needed; snippets in CLAUDE.md and above).

_(Cleanup done at resolution, see §8.12: `sw-debug.ts` deleted, `vmodule` switch removed,
`[mira-sw-msg]` already removed while coding the shim; `cdp-eval.ts` KEPT as hardening.)_

### 8.12 ✅ RESOLUTION (2026-07-11 evening) — the shim was right, its preload never ran

**Kondo works** (confirmed by the user after restart: no more "Browser extension
stopped" dialog). Option 1 of §8.11-G (`navigator.serviceWorker ↔ chrome.runtime` shim) is the route
chosen and VALIDATED. Account of the resolution, for the record:

#### What was done

1. **The shim was coded (Codex session)**, faithful to the §8.11-G design, in two halves in
   `src/main/extension-capabilities.ts`:
   - _SW half_ (`SERVICE_WORKER_BRIDGE_SW_MAIN_WORLD`): `chrome.runtime.onConnect` on the private
     port `__mira_extension_service_worker_bridge_v1__` → recreates a local `MessageChannel` →
     dispatches a synthetic `MessageEvent('message')` with a real port on `self` → relays the
     data (JSON) between the local port and the runtime port. Installed via the existing alarms preload
     (so BEFORE the lib's `Object.freeze(chrome)`).
   - _Frame half_ (`SERVICE_WORKER_BRIDGE_FRAME_MAIN_WORLD`): in a nested `chrome-extension://` page
     whose `controller` is null, patches the `navigator.serviceWorker.ready` getter to
     resolve to a pseudo-registration whose `.active.postMessage(msg, [ports])` opens a
     `chrome.runtime.connect` and relays. One runtime port per `postMessage` call; MessagePorts
     NEVER cross `chrome.runtime` (each side builds its local pair, only
     the data is relayed — the key of the design).
   - Native wiring: `registerRuntimeShims` (`extensions.ts`) writes both sources into
     `userData/sw-shims/` and registers them per session (`registerPreloadScript`, types
     `service-worker` and `frame`) before the construction of `ElectronChromeExtensions`.

2. **Review after "it still doesn't work" (this session)** — verdict: **the shim's logic
   was CORRECT, its only flaw was delivery.** End-to-end proof WITHOUT a restart, by
   inlining the frame half verbatim into the script of a probe mini-extension loaded as an iframe
   nested in app.trykondo.com (= simulating "the preload ran"): `ready` resolves →
   `postMessage` with a transferred port → **the SW's answer received through the full bridge**
   (`swReply: {status:'connected-from-sw'}`), with SW logs to back it (`onConnect name=__mira_…` then
   `message event, source=mira-probe ports=1`). Both halves, the transport and the return relay
   work.

#### THE bug (one line of webPreferences)

**Electron only runs preloads in the main frame**, unless the webPreferences set
`nodeIntegrationInSubFrames: true`. Verified all the way into the Electron 41 source
(`ShouldLoadPreload`, `shell/renderer/renderer_client_base.cc`, branch 41-x-y):
`is_main_frame || is_devtools || allow_node_in_sub_frames`. Yet:

- the tab views (`materializeTab`, `profiles.ts`) only set `{ partition }` — the flag
  existed nowhere in the repo nor in the lib;
- the frame half of the shim **deliberately disables itself at top level** (`if (top === self) return`):
  it targeted ONLY nested iframes… the only place where its preload did not run.
  → 100 % dead code, silently (no error anywhere).

Direct proof (probe without inlining, build 19:44): in the nested iframe `bridgeInstalled: false`
and `ready` times out, whereas all the guards of the frame half would have passed.

#### The fix (validated)

`nodeIntegrationInSubFrames: true` in the webPreferences of the tab views (`materializeTab`,
`profiles.ts`) and of the OAuth popups (`overrideBrowserWindowOptions` of the `setWindowOpenHandler`, same
file — password managers also inject iframes into popups). Accepted cost: the
session preloads (lib + ours) now run in every iframe of every page, but
both gate out immediately outside `chrome-extension://` — negligible overhead. Flag labeled
"experimental" by Electron; it is the mechanism intended for this need.

#### Facts established along the way (useful for E2)

- `chrome.runtime.connect` **works from a nested extension iframe** (full ping/pong
  to the SW, proven live) — the last link of the design that had not been proven until then.
- Kondo's surface is minimal: the whole `ext.html` script (`assets/settings.js`) fits in 4
  lines and touches ONLY `navigator.serviceWorker.ready` → `.active?.postMessage(...)`, **inside its
  message handler** (triggered by the web app's retries) — so no race between
  the installation of the patch and the reading of `ready`.
- Kondo's SW handler (`de` in `background-vYAqPXIO.js`) only checks
  `e.data?.source === 'kondo-iframe'` and `e.ports[0]` — neither `origin` nor `source` (which the synthetic
  dispatch cannot provide).
- Kondo keeps its SW alive on its own: `setInterval(chrome.runtime.getPlatformInfo, 20 s)`
  (that is why its SW does not cycle, whereas idle SWs die at ~30 s and are relaunched by
  our keepalive).

**Scope**: the shim + the flag unblock the whole class "iframe-WAR → SW bridge via
`navigator.serviceWorker`" (password managers, clippers — the cases of electron-browser-shell#172),
not just Kondo. To check in E2 (1Password, Obsidian Web Clipper).

**Cleanup done**: `sw-debug.ts` deleted (+ its call in `ensureFor`), `vmodule` switch removed
from `index.ts`. **Kept as hardening**: `cdp-eval.ts` (+ tests) — routes `exec-js` through
`Runtime.evaluate` when a CDP debugger is attached, with a timeout.

## 9. E8 — Claap: native SIGTRAP crash + offscreen / desktopCapture / tabCapture shims (2026-07-13)

**✅ VALIDATED FOR REAL on 2026-07-13** (dev restart by the user): no more crash at boot with Claap
installed, strip applied (Claap AND Bitwarden — which also declares `offscreen`), offscreen host
mounted (`[mira-offscreen] hosting …`), `enumerateDevices` of the offscreen doc run without SIGTRAP,
idempotence of createDocument confirmed on the SW keepalive cycle, and **Claap recording tested
by the user: it works**. Cosmetic limit spotted: the injected webcam bubble
(`camera.bundle.js` in an iframe) is blocked by the Blink permissions policy ("camera is not
allowed in this document") — Chrome exempts extension iframes, Electron does not. To dig into if
one day the thumbnail is really missed.

**Symptom**: installing Claap (`bnflmljpbmkjeahgjakmjdanmhldjhbk`) **kills Mira** — SIGTRAP of the
browser process ~1 s after the extension loads.

**Root cause PROVEN** (crash `Electron-2026-07-13-120303.ips` symbolicated with the official breakpad
symbols of Electron 41.7.0 — identical UUID): Electron 41 **compiles chrome.offscreen**
(`OffscreenDocumentManager` is in the binary, the document is really created), but the offscreen
document is an _extension host_ whose media permission check goes through
`ElectronExtensionHostDelegate::CheckMediaAccessPermission` →
`extensions::media_capture_util::VerifyMediaAccessPermission` — a **release CHECK** on the
`audioCapture`/`videoCapture` permissions (_platform app_ permissions, which no MV3 extension
can hold). Claap's offscreen doc is used to "list media devices": its first
`enumerateDevices()` → CHECK → SIGTRAP of the whole process. Same family of trap as Kondo's DNR crash
(§8.2.3): a half-wired native path, fatal on mere use.

**Fix (coded, tested, typecheck OK — to validate at the next dev restart)**:

1. **Strip `offscreen` at load** (`stripUnsupportedPermissions`): the native namespace no longer
   exists, the trapped path is dead. Same pipeline as the DNR strip (backup
   `manifest.mira-original.json`, gaps/Tier C read the original).
2. **`chrome.offscreen` shim**: main-world SW half (`OFFSCREEN_SHIM_SOURCE`,
   `extension-capabilities.ts`), `ServiceWorkerMain.ipc` bridge (the lib's transport), backend
   `OffscreenHostService` (`extension-offscreen.ts`) — the offscreen page runs in an
   **ordinary hidden BrowserWindow** on the profile's session: media permissions = normal session
   path (grant-all, `permissions.ts`), no more trapped extension host. `createDocument`
   deliberately **idempotent** (our host is invisible to `runtime.getContexts`, and the
   keepalive relaunches the SWs' init). Also provides `runtime.ContextType` if `getContexts` exists
   without it (Claap dereferences it).
3. **`chrome.desktopCapture` shim** (extension pages, frame preload
   `CAPTURE_SHIM_FRAME_SOURCE` + backend `ExtensionCaptureService`, `extension-capture.ts`):
   `chooseDesktopMedia` → `desktopCapturer.getSources` on the main side, screen source auto-chosen (no
   picker), `streamId` compatible with `getUserMedia {chromeMediaSource:'desktop'}` — exactly the
   flow of Claap's recorder (`pinnedTab.bundle.js`). `canRequestAudioTrack:false`, honest (no
   macOS loopback); Claap gates its audio on it.
4. **`chrome.tabCapture.capture` shim**: arms the session's `setDisplayMediaRequestHandler`
   for the calling frame (TTL 10 s, single-use) then `getDisplayMedia`; the handler resolves to
   **the active tab** (Chrome semantics) in video **and audio** — `audio: WebFrameMain` captures
   a tab's audio even on macOS (verified in electron.d.ts). An unarmed `getDisplayMedia`
   is refused (previous behavior: no handler = deny). `activeTab` hook added to
   `ExtensionTabHooks` (`profiles.ts`).

Registration order: all shims BEFORE the construction of `ElectronChromeExtensions` (the lib's
`Object.freeze(chrome)` makes any later addition silently inert — §8.12).

### 9.1 — Webcam bubble (Permissions-Policy) + keyboard shortcuts (coded 2026-07-13, to validate)

**Webcam bubble.** Claap's camera iframe (`camera.html`, injected into pages) already carries
`allow="camera;microphone"` — the block came from the **`Permissions-Policy` header of the parent
page** (`app.claap.io` sends `camera=(self), microphone=(self)`): the parent's declared policy
excludes the extension origin, and the `allow` attribute cannot widen it again. Chrome exempts
extension frames from this computation; Blink under Electron does not. **Proven live**: the same
iframe on `example.com` (no header) loads and posts `cameraFrameReady` without a violation.
Fix: `relaxPermissionsPolicy` (`extension-capabilities.ts`, pure, tested) adds the origins
of the loaded extensions to the `camera`/`microphone`/`display-capture` allowlists of the
`Permissions-Policy` headers of document responses — applied in the existing `onHeadersReceived`
(`extensions.ts`), now installed as soon as a session has extensions (no longer only when
there is DNR).

**Extension keyboard shortcuts** (manifest `commands` — Claap: Cmd+Shift+S →
`_execute_action`). New `extension-commands.ts`: parsing of `suggested_key` (mac; `Ctrl`
→ Command like Chrome), matching on `before-input-event` of ALL webContents (tabs +
chrome — no `globalShortcut`: browser scope, and `input.key` is layout-aware, no
AZERTY trap). `_execute_action` clicks the real toolbar button in the chrome's `<browser-action-list>`
(open shadow root, same path as a user click → anchored popup) via the
new `chromeWebContents` hook of `ExtensionTabHooks`. Named commands go to
`chrome.commands.onCommand` through the lib's internal router
(`ExtensionsService.sendCommandEvent`, guarded access to `instance.ctx.router` — the lib overwrites our
`onCommand` with its ExtensionEvent, its listeners can only be reached that way; its `sendEvent`
wakes up a stopped SW). No menu collision: Mira has no Cmd+Shift+S (Discard Tab = Cmd+S).

**To validate at restart**: (1) webcam bubble visible on app.claap.io during a recording;
(2) Cmd+Shift+S opens the Claap popup (page focus AND address bar focus).

**TCC trap found during validation — "recording no longer works".** Not a code regression:
in dev, Mira is launched from a terminal app, so macOS attributes camera access to that
**responsible process** (`responsibleProc: <terminal app>` in the crash reports). That terminal app's
Info.plist had `NSMicrophoneUsageDescription` (hence the mic OK) but NOT
`NSCameraUsageDescription` → on the first camera access, TCC **SIGABRTs Chromium's video capture
service** ("attempted to access privacy-sensitive data without a usage description",
`Electron Helper-*.ips`). Chromium relaunches it then gives up (`Too many GetDeviceInfos()
retries` in the log) → every device enumeration dies → the Claap recording gets stuck.
The crash ALREADY existed during the earlier session where recording worked, but stayed
under the retry limit; the permissions-policy fix increased the camera pressure (the bubble
attempts a real video getUserMedia) and the limit was reached. **Fix**: `NSCameraUsageDescription`
added to the `Info.plist` of the terminal app that launches Mira in dev — effective at that app's next build+relaunch
(do NOT re-sign an installed app while it is running, risk of a kernel
SIGKILL). In the meantime: a restart of `npm run dev` resets the retry counter to zero,
and recording works again (especially with the camera turned off on the Claap side).

**To validate at restart** (the user relaunches `npm run dev`): (1) boot without SIGTRAP with Claap
installed (the strip runs at boot via `sanitizeStoreDir`); (2) log `[mira-offscreen] hosting …`
and no more Claap "Failed to start service worker" error; (3) functional Claap popup;
(4) a test recording — mic + screen via the desktopCapture shim; tab audio goes
through tabCapture (macOS "Screen Recording" permission required for the Electron app, otherwise
`getSources` returns empty sources — the `[mira-capture]` log flags it). Known open points:
no source picker (whole screen by default), `commands` (Claap's Cmd+Shift+S) still inert.

## 10. E9 — `chrome.storage.onChanged` never delivered to service workers (2026-08-30)

**Visible symptom.** Bitwarden vault unlocked, but right-clicking on a page offers
"Unlock your vault" under each of its submenus (Autofill login, Copy username…).

**Chain of causes, verified end to end.**

1. That title has **only one producer** in the Bitwarden bundle: `noAccess()`, reached when
   `authService.getAuthStatus() !== Unlocked`. Confirmed by the arithmetic of the
   `contextMenus.create` calls read in the SW (`mira call extension-console`): regular cycles of
   11 then 17 on one profile (premium), 10 then 15 on another — i.e. `init()` then
   `init()` + one NOOP child per parent, the exact signature of `noAccess()`. No other
   path (`noLogins`/`noCards`/`noIdentities`) gives these counts.
2. The vault IS unlocked on the storage side: `chrome.storage.session` contains
   `user_<id>_crypto_userKey` (read from an extension page opened as a tab), and the active
   account is indeed that one (`global_account_activeAccountId`).
3. **The gap.** Probe extension loaded in the test profile (permissions `["storage"]`, a SW
   that listens to the three `onChanged`): an extension **page** receives all events,
   including those caused by the SW's `set`; the **service worker receives none**, not even
   its own. Reads/writes, on the other hand, are shared (the SW reads back what the page wrote).
   Electron only dispatches storage changes to renderers.
4. Bitwarden builds its cross-context `updates$` directly on `<area>.onChanged`
   (class `ZR` of its `background.js`). Unlocking happens in the POPUP, which writes the
   key; the SW is never told, its cached view stays `null`, and it believes it is locked
   forever — until the worker's next start.

**Fix (coded 2026-08-30).** Same shape as the `chrome.webRequest` bridge: pure half +
Electron half.

- `src/main/extension-storage-events.ts` — channels, `changesFrom` / `readStorageReport`, and the
  two injected sources. The **worker** half replaces `chrome.storage.onChanged` and
  `<area>.onChanged` (inert) with real events; the **frame** half only
  reports writes (renderers already have the native events — dispatching there too
  would fire twice).
- `src/main/extension-storage-events-service.ts` — the two preloads, the worker ipc, the routing.
  The extension id always comes from the sender (frame url or worker scope), never from the
  payload.
- Wired in `extensions.ts` **after** `new ElectronChromeExtensions(...)`, like the two other
  bridges: the lib rebuilds `chrome.storage` then does `Object.freeze(chrome)`, a shallow freeze
  — measured in a worker: `chrome.storage` extensible, `set` own/writable/configurable.

**Two explicit choices.** (1) Reading the old values is started in the SAME tick as
the write, without waiting for it: a write is never delayed, so two close writes
keep their order; a race costs a wrong `oldValue`, never a lost write. (2) No
deduplication by value: a `set` of the same value fires an event again. One event too many
costs a recomputation, a missing one is precisely the bug.

**Scope.** `local` and `session` only — the lib aliases `sync` and `managed` to the `local`
OBJECT itself (`chrome.storage.local === chrome.storage.sync`, verified), so a write
through one of them is a local write, reported as such. A content script writes in an
isolated world that the frame preload does not reach: its writes do not wake up the SW.

**First draft inoperative, and why — two flaws, both fixed on 2026-08-31.**

**(1) Events set by assignment.** An **area**'s `onChanged` is an **accessor**
(`get: true`, no setter — measured in a real worker), so
`chrome.storage.session.onChanged = …` is **silently ignored** in sloppy mode and
the inert native event stays in place. Bitwarden listens on the area (`ZR` receives
`chrome.storage.local` / `.session`), so the bridge changed nothing for it: it ran, raised
nothing, did nothing. `chrome.storage.onChanged`, at the top, is a data
property: that one was indeed replaced, and that is what made it possible to check live that the
rest of the route worked (a write made in a page does reach the worker, with the right
area name). Fixed by `Object.defineProperty` at both levels (`defineWorked: true` in the
worker).

**(2) Values crossing the IPC — the costly flaw.** The bridge read the old value
before each write and sent old+new to main, which sent the change set back to the worker.
Measured on a real profile: Bitwarden keeps its decrypted vault in **ONE**
`chrome.storage.local` key of **1.45 MB** (`session_<user>_ciphersMemory_decryptedCiphers`, next to
a 1.66 MB `_ciphers_ciphers`) and rewrites it on every sync, unlock and cipher
change. Each write thus became a 1.45 MB read + ~3 MB crossing processes

- 1.45 MB back, on the worker's hot path, at unlock time. Observed
  symptom: **no Bitwarden submenu at all anymore**, on that profile only. Its trace is
  unambiguous — a `contextMenus.removeAll` then a `tabs.query`, zero `create`, on every cycle:
  `init()` returns true without creating anything, which only happens through `if (this.initRunning) return true`,
  so an `await` left pending inside.

**The bridge no longer makes any value cross.** A context reports `{area, saved, removed}` —
**key names** — and the worker builds Chrome's shape: `{newValue: undefined}` for a
save, `{}` for a removal. `'newValue' in change` — the test a state framework
switches on, and the one Bitwarden uses — thus stays exact; `oldValue` and the real
`newValue` are no longer provided, a listener that needs the value reads it back with
`chrome.storage.get` (which a service worker has to do anyway on every restart).
Putting the values back would require a size budget, and a size budget cannot be computed
without serializing the value first. Corollaries: no more read before write at all (so no more
risk of order inversion either), and `clear()` is the only case that still reads — the **names**
of the keys, via `getKeys()` if Electron has it.

**One more gate**: the worker tells main whether it has at least one storage listener, once
at startup then at each toggle. Main sends it nothing when it said no. The state is
**tri-state** on purpose — a worker main has never heard from is treated as listening:
a lost announcement costs a few tiny messages, never a mute bridge, a failure already paid for
once here.

**The tests' fake `chrome` models the accessor**: without it, four tests passed on a shim
that did not install. Switching back to assignment makes them fail.

**Two tooling traps met along the way.** (1) Mira's service-worker preloads do NOT
install in an extension hot-loaded into the **test profile** (neither the `alarms`
shim, nor the webRequest bridge, nor this one) whereas they do install in the `default` profile —
so a probe loaded in the test profile says nothing about the shims, cause not investigated.
(2) `extension-console` returned nothing for this probe while the Chromium log contained its
lines: to read a probe, `~/Library/Application Support/mira/logs/chromium-*.log` is the
reliable source. (3) `chrome.storage.session` is **emptied by a disable/enable** of the extension
(verified with a probe): restarting Bitwarden's service worker that way locks its
vault again, it is not a free debug tool.

**Still to validate for real**: right-click on a page, vault unlocked → the site's
credentials, no more "Unlock your vault".
