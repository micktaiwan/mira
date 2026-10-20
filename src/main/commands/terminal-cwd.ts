// Terminal folder domain: the folder a profile's embedded Kova terminal (the
// right-side pane running claude) starts in. Per profile, since claude loads the
// CLAUDE.md of that folder. The pure model lives in src/main/terminal-cwd.ts; the
// ProfileManager implements the slice (checks the folder on disk, persists
// profiles.json). Read back through list-profiles (`terminalCwd`).

import { type CommandMap, fail, type ProfileInfo } from './registry'
import type { CommandContext } from './context'

/** Terminal folder capability slice. */
export interface TerminalCwdContext {
  /** Set a profile's terminal folder (absolute or `~/…`, must exist) or clear it
   * with null (back to the home folder). Throws on an unknown profile, a relative
   * folder or one that does not exist. Applies to the next pane opened. */
  setProfileTerminalCwd: (id: string, cwd: string | null) => ProfileInfo
}

export interface SetProfileTerminalCwdParams {
  id: string
  /** A folder, or null / '' to clear (start in the home folder). */
  cwd: string | null
}

export const terminalCwdCommands: CommandMap<CommandContext> = {
  'set-profile-terminal-cwd': (ctx, params) => {
    const { id, cwd } = (params ?? {}) as Partial<SetProfileTerminalCwdParams>
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: 'missing "id"' }
    }
    // Required, so a misspelled key ("path") fails instead of clearing the folder.
    if (cwd === undefined) return { ok: false, error: 'missing "cwd"' }
    if (cwd !== null && typeof cwd !== 'string') {
      return { ok: false, error: '"cwd" must be a string or null' }
    }
    try {
      const updated = ctx.setProfileTerminalCwd(id.trim(), cwd)
      return { ok: true, id: updated.id, terminalCwd: updated.terminalCwd ?? null }
    } catch (error) {
      return fail(error)
    }
  }
}
