# Mira — import from ChatGPT Atlas (notes)

Detail of the "bookmarks import" and "open tabs import" workstreams from ChatGPT Atlas
(OpenAI's Chromium browser). `track.md` keeps only one status line for it.

## Bookmarks import (active to-do)

Goal: a drivable command that reads Atlas's bookmarks file, goes through
`importAtlasTree` (pure function already written + tested, maps the Atlas format → our
tree) and merges into the Mira tree.

Missing: the disk-read wiring. The Atlas file `bookmarks/BookmarkBar` is **JSON** (no plist
here — the plist is for the pinned tabs), so
`JSON.parse(readFileSync(...))` → `importAtlasTree` → merge.

Open decisions:

- **Which profile** (default = the main one, which holds most of the bookmarks).
- **Replace** the tree OR import into an **"Imported from Atlas"** folder
  (recommendation: folder, non-destructive).
- Dedup by url.

## Atlas bookmarks format (verified on disk 2026-07-10)

`~/Library/Application Support/com.openai.atlas/<profil>/bookmarks/BookmarkBar` — one
**JSON** per profile (`bookmarks` is a folder). Recursive tree. Node:

- `id` (int), `uuid`, `title`
- `type`: a one-key object — `{bookmarkBar:{}}` root | `{folder:{}}` | `{url:{}}`
- `children[]`, `parentUUID`, `url` (if type url)
- **No timestamp/favicon.**

A real-world profile can hold several hundred urls and over a hundred folders.

## Open tabs import (idea — done by hand once)

Done **by hand** once (tabs of an Atlas profile reimported into a Mira profile through the
socket: `new-tab` then `pin-tab`). **Verified** constraints for a future drivable import:

1. **Reliable source** = the **SNSS** files
   `com.openai.atlas/browser-data/host/<profil>/Sessions/Session_*` — a **separate tree**
   from the bookmarks (`com.openai.atlas/<profil>/bookmarks/BookmarkBar`).
2. **Several profiles** = ChatGPT accounts, folders `user-<acct>__<guid>`
   (+ `__1/__2` variants per window); ignore the ephemeral `login-staging-*` ones.
3. **AppleScript** (`tell application "ChatGPT Atlas"`) works but **under-reports** — it
   only enumerates loaded tabs (it missed most of them).
4. Chromium **alternates between 2 `Session_` files**: the most recent one is not always
   the live window (the real tabs were in the older file).
5. The **pinned** flag cannot be decoded reliably from Atlas's SNSS / Chromium 149 → pinning
   has to come from elsewhere (visible icon grid, or manual input).
