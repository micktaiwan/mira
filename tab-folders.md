# Tab folders

Design + status of **putting open tabs into folders** in the left sidebar.
**V1 implemented** (to validate in the app) — see §Architecture (implemented V1).
Indexed in `track.md`.

Origin: a first attempt confused the request with **bookmarks** (a bookmark tree shown in a
sidebar panel). That was a misunderstanding, fully reverted. The real request is about
**open tabs**, not bookmarks.

## The landmark that frames everything: Cmd+K is central, not a bookmarks panel

**Bookmarks are not a sidebar panel. They live in Cmd+K.** The command palette (`Cmd+K`,
already implemented) already lists the flattened bookmarks among its entries
(`buildPaletteEntries`, see `track.md` §Palette design). Quick access to a bookmarked site
is therefore done by typing `Cmd+K` + a few letters, not by clicking an always-visible
list.

Product direction consequence: **Cmd+K must become the central reflex** for navigation
(open a bookmark, jump to a tab, run a command). That is why a "Favorites" panel in the
sidebar has no reason to exist — it would duplicate what the palette already does better.
The sidebar stays dedicated to **open tabs** (and to grouping them into folders, below).

## Model — what is DECIDED

- **Purely visual grouping.** A folder groups open tabs in the sidebar. Tabs stay normal
  tabs: a `WebContentsView`, selection, navigation — nothing changes in their lifecycle. The
  folder is a label, not a container that changes the nature of the tab.
- **A tab belongs to 0 or 1 folder.** Unfiled tabs stay in a **"loose" zone**, as today. We
  do not force every tab into a folder.
- **Collapse = visual only, tabs stay ALIVE.** Collapsing a folder hides its tabs in the
  sidebar but does **not** put them to sleep (no RAM unloading).
- **Persistent.** The structure (folders: name, collapse, order; each tab's membership)
  survives a restart. It goes into `session-store` (the file that already saves the tabs per
  window).
- **Right-click on a tab → file it.** A context menu on a tab row offers: **file into an
  existing folder**, or **create a new folder** (and file the tab into it). It is the main
  entry point for filing.
- **Depth: 1 level only.** A folder contains tabs, no subfolders.
- **Order: fixed sections.** Top → bottom: pinned grid, then **folders**, then **loose**
  tabs. Folders sit between the pinned and the loose ones (no free-form list à la Arc).
- **`Cmd+↑`/`Cmd+↓` navigation: visual order.** We walk pinned → tabs of **open** folders →
  loose, **skipping** the tabs of **collapsed** folders. If the active tab is hidden in a
  collapsed folder, we enter through the first/last visible tab.
- **Right-click menu: native** (Electron `Menu.popup`), not HTML — always above the
  `WebContentsView`, never clipped. **First native menu already coded** (New Tab / Duplicate
  / Pin-Unpin / Close), it is the "seam" where the "Move to folder / New folder" items will
  plug in. See `tab-menu.ts` (pure tested list) + `commands/tab-menu.ts`
  (`show-tab-menu {tabId}`) + `showTabMenuIn` in `profiles.ts`.
- **Deferred (later, not in V1):** per-folder options to **show the folder's RAM usage** and
  a **quick clear** button (unload/put to sleep the folder's tabs). Collapse stays without
  RAM effect in V1; clear will be a separate explicit action.

## Architecture (implemented V1)

Model: **membership lives on the tab** (`TabMeta.folderId`, like `pinned`) — that is what
makes it **survive the restore** (tab ids are regenerated, a separate id→folder map would
not survive). The folder **metadata** (title, collapse, order) is a separate list.

- **Pure / tested**: `src/main/tab-folder-store.ts` — model `TabFolder {id,title,collapsed}`,
  ops (add/rename/remove/collapse/setTabFolder/clear/prune) + `navigableTabIds` /
  `nextNavigableTabId` (the Cmd↑/↓ order). Tests: `tab-folder-store.test.ts`.
- **Persistence**: `session-store.ts` — `folderId` per tab + `folders[]` per window
  (written only when present → compat with old files). Restore recreates the tabs with their
  `folderId` then prunes the dangling ones.
- **Commands** (`commands/tab-folders.ts`, drivable over socket/MCP, tested):
  `create-tab-folder {title, tabId?}`, `rename-tab-folder`, `remove-tab-folder` (dissolves,
  does not delete the tabs), `toggle-tab-folder`, `move-tab-to-folder {tabId, folderId|null}`,
  `list-tab-folders`.
- **ProfileManager** (`profiles.ts`): field `pw.folders`, push of `folders` on
  `mira:tabs-changed`, `folderId` in `tabInfos`, nav via `nextNavigableTabId`, pin that takes
  the tab out of its folder, prune on close, `showTabMenuIn` feeds the native menu.
- **Right-click menu** (`tab-menu.ts`): **Move to Folder** submenu (existing folders +
  **New Folder…**) and **Remove from Folder** — hidden on a pinned tab.
- **UI**: `Sidebar.tsx` renders pinned → **folders section** (`FolderHeader`: caret/collapse,
  rename on double-click, × to dissolve) → loose. Tabs in a folder = the same `TabRow`
  (shared drag). Styles: `assets/tab-folders.css`.

**Gesture rule**: **drag within the same section** = reorder (`move-tab`); **drag to another
section** (a row of another group, or **onto a folder header**) = change membership
(`move-tab-to-folder`); **right-click** also does Move/Remove. **Naming at creation**: "New
Folder" creates a folder named "New folder" and the sidebar immediately opens its name field
(selected) — a native menu cannot ask for text. Collapse is visual (no RAM effect; per-folder
clear/RAM stays deferred).

**Still to validate in the app**: driven through dev (`npm run dev`) — check right-click →
Move/New/Remove, collapse, Cmd↑/↓ nav that skips collapsed folders, and survival across a
restart.

## Distinctions to keep in mind

- **Tab folders ≠ pinned tabs.** Pinned tabs stay the compact grid at the head of the strip.
  A folder groups normal tabs, not pinned ones.
- **Tab folders ≠ bookmarks.** Bookmarks are saved URLs (`bookmark-store.ts` tree, native
  menu, star, Cmd+K). Tab folders group **live open tabs**. Two distinct features.
