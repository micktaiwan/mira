// The folder a profile's embedded Kova terminal starts in (the right-side pane
// running `claude`, kova-pane.ts). It matters beyond comfort: claude loads the
// CLAUDE.md of the folder it starts in, so the folder decides the context the
// pane's session has. Per profile, so a work profile and a personal one can
// start in different folders. Pure (the file system is injected), unit-tested in
// terminal-cwd.test.ts; profile-store.ts persists it, profiles.ts launches with it.

/** Normalize a folder typed by the user (Settings, socket): trimmed, a leading
 * `~` expanded to `home`, trailing slashes dropped. Returns null for "clear"
 * ('' or null). Throws on a relative path: the pane has no current folder to
 * resolve it against. Existence is checked by parseTerminalCwdInput. */
export function normalizeTerminalCwd(raw: string | null, home: string): string | null {
  const trimmed = (raw ?? '').trim()
  if (trimmed === '') return null
  const expanded =
    trimmed === '~' ? home : trimmed.startsWith('~/') ? `${home}/${trimmed.slice(2)}` : trimmed
  if (!expanded.startsWith('/')) throw new Error(`not an absolute folder: ${trimmed}`)
  const stripped = expanded.replace(/\/+$/, '')
  return stripped === '' ? '/' : stripped
}

/** What set-profile-terminal-cwd stores: the normalized folder, refused when it
 * is not an existing directory now (a typo must fail where it is typed, not
 * silently open the pane in the home folder later). null = clear. */
export function parseTerminalCwdInput(
  raw: string | null,
  home: string,
  isDirectory: (path: string) => boolean
): string | null {
  const cwd = normalizeTerminalCwd(raw, home)
  if (cwd !== null && !isDirectory(cwd)) throw new Error(`no such folder: ${cwd}`)
  return cwd
}

/** The folder the pane actually starts in: the profile's folder when it is still
 * a directory, else `home` (the folder was moved or deleted since it was set:
 * the pane must still open). */
export function resolveTerminalCwd(
  stored: string | undefined,
  home: string,
  isDirectory: (path: string) => boolean
): string {
  return stored !== undefined && isDirectory(stored) ? stored : home
}
