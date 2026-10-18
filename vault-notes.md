# Mira — per-profile isolation & encrypted profiles (notes)

History and technical detail of the "full per-profile isolation" and "encrypted profile
(vault)" workstreams. `track.md` keeps only one status line for it; the whole story lives
here.

## Decision (2026-07-11)

Each profile is an **isolated storage unit**: one profile's history, permissions and
bookmarks must NOT leak into another.

- Isolated from the start: the **Electron partition** (cookies/localStorage/IndexedDB,
  `Partitions/mira-<id>/`), the **tabs** (`sessions.json`, keyed by id) and the
  **extensions**.
- Still leaking: `history.json` and `permissions.json` (flat global arrays).
  → made **per profile**.
- **Bookmarks per profile too** (reverses the earlier "minimalist global" choice).
- **Settings stay global** (home URL, LLM key, widths — not browsing data).
- **No migration**: OK to throw away the current history (confirmed).

## Per-profile storage (DONE 2026-07-11)

1. Refactor of `ProfileManager` into collaborators: `llm-runner.ts`,
   `tooltip-controller.ts`, `bookmarks-controller.ts`, `profile-data.ts`.
2. History + permissions + bookmarks live in
   `userData/profiles/<id>/{history,permissions,bookmarks}.json`, one
   `ProfileData` / `BookmarksController` per id (`dataFor` / `bookmarksFor`,
   lazy creation).
3. `recordVisit` / `recordGrant` / bookmarks routed to the targeted profile;
   permissions/bookmarks broadcast scoped to the profile's window; native Bookmarks
   menu = tree of the focused profile (rebuilt on focus change).
4. The history/permissions/bookmarks commands act on the focused profile.

Tests OK. To validate in the app after a build (rebuild required).

## Encrypted profile — vault (drivable core DONE 2026-07-11)

Model: **decrypt to the normal location, re-encrypt at rest** (no symlink, decided).

- **AES-256 per-profile** `.sparsebundle` vault in `userData/vaults/<id>.sparsebundle`,
  encrypts BOTH of the profile's folders (`profiles/<id>` trails + `Partitions/mira-<id>`
  cookies).
- `vault.ts` (pure, tested: `vaultPlan` / `assertEncryptable` / `needsUnlock` — the
  default profile cannot be encrypted, it has no self-contained folder).
- `vault-service.ts` (native `hdiutil` + cp/rm, **verify-before-wipe** on
  encrypt+lock).
- Domain `commands/vault.ts`: `encrypt-profile` / `unlock-profile` /
  `lock-profile` / `list-vaults` (drivable + tested); `Profile.encrypted` flag
  persisted.
- `ProfileManager`: `unlockedVaults` (id→password in memory), `openProfile` gated
  on a locked profile, skipped at startup.
- **encrypt/lock require the window to be closed** (race on the Electron handles avoided).

### Native validated for real (2026-07-11)

Via `vault-service.integration.test.ts` (guarded by `MIRA_VAULT_IT=1`, real
`hdiutil` on a throwaway temp folder, 5/5: encrypt+wipe, unlock intact, edit
persists after lock, wrong password rejected, discard). Cleans up after itself (no
leftover volume).

## Lifecycle (settled + wired 2026-07-11)

1. **Auto-lock on window close** — `closed` handler, outside quit (async,
   fire-and-forget).
2. **Session loss on unclean shutdown = OK** ("incognito that keeps the cookies")
   → no reconciliation: at startup `reconcileVaults()` **erases** the plaintext left
   over from an encrypted profile (the vault is authoritative), `discardPlaintext`
   in vault-service.
3. Password in clear in RAM while unlocked = accepted.

## Password dialog UI (DONE + in-app flow validated 2026-07-12)

Native dialog in Settings → Profiles (`VaultPasswordDialog`, Encrypt/Unlock/Lock
buttons, locked badge); encrypt→unlock→use→lock cycle exercised for real.

## The "lost cookies" saga (logged out at every cycle)

### First cause found + fix (2026-07-12)

Electron caches a partition's `Session` object for the whole life of the app and NEVER
rereads it when the vault swaps the files underneath → a 2nd unlock in the same run serves
an empty session = logged out (proven: disk = 37 cookies, file not even touched again, but
empty session).

**Fix = per-unlock nonce partition** (`noncePartitionDir` → live folder
`mira-<id>-<nonce>` never seen by Electron → fresh session that reads the restored
cookies); every partition resolution goes through `effectivePartition` (map
`unlockedPartition`); `flushStore()` / `flushStorageData()` at lock before the copy;
eviction + `ProfileData.dispose()` of the `dataById` / `bookmarksById` caches at
lock/unlock (cancels the debounce timers → also fixes the leak of `history.json`
recreated AFTER the erase); `reconcile` erases orphaned nonce folders by name
(`discardProfilePlaintext` + `isProfilePartitionDir`, glob).

Validated in dev: unlock → use → lock → re-unlock keeps the cookies.

### Bug came back, REAL cause (2026-07-12)

The nonce was NOT the recurring cause. Proven (isolated Electron bench) that copying the
partition **without a flush** loses even the **persistent** cookies (Chromium buffers them
in RAM); and Mira only re-encrypted the vault on **window close** (auto-lock), **never on
app quit** → quitting with the profile open (`open:true` in sessions.json) froze the vault
at the last lock, `reconcileVaults` erasing the plaintext at boot → every session thrown
away again.

Encryption **not at fault** (cookies stored in clear, no "Mira Safe Storage" key in the
Keychain → fallback, unencrypted).

**Fix (code done) = lock-on-quit**: `before-quit` defers the quit, closes the windows,
re-encrypts every open vault, then quits (`lockAllVaults` / `performVaultLock` extracted,
`lockingAll` guard so as not to double the auto-lock);

- flush added to `encrypt-profile`; + drivable command `lock-all-vaults`
  (panic-lock). Unit tests + socket doc up to date.

### Unfixed leftovers (minor)

- Session cookies lost per cycle (normal).
- `flushStorageData` not `await`ed (masked by the hdiutil delay).

## Still to do

**NOT YET VALIDATED FOR REAL** (native Electron, outside unit tests) → to exercise:
unlock → login → Cmd+Q → re-unlock → still logged in. To activate the fix: close the
encrypted profile's window (saves through the old auto-lock) THEN restart Mira to load the
new code.
