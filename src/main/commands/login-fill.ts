// Login FILL domain: putting a credential the vault already holds into the login
// form of a page. The mirror of commands/logins.ts, which only ever goes the
// other way (read what is stored, write what was typed).
//
// Its own domain file rather than three more entries in logins.ts, for the reason
// the registry states: one file per feature keeps parallel sessions off each
// other's diffs (CLAUDE.md, découpage anti-collision).
//
// Two commands, and the split between them is the whole design:
//   - `login-candidates` answers "which accounts could log in here?" — a list,
//     never a password, nothing touched on the page.
//   - `fill-login` fills. With no id and no username it only acts when the answer
//     is not a guess (one matching account, or the one used last time on this
//     site); otherwise it fills NOTHING and answers with the same list, because a
//     wrong password typed into a live form is a lockout.
//
// Neither command ever returns a password, and neither ever submits the form.

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'

/** One fillable account as the socket/UI sees it. `exact` marks the accounts
 * filed under this very host, as opposed to a sibling subdomain of the site. */
export interface FillCandidateInfo {
  id: string
  name: string
  username: string
  hosts: string[]
  exact: boolean
}

/** What a fill answered: either it filled, or it is asking which account. */
export interface FillResult {
  profileId: string
  url: string
  host: string
  filled?: {
    id: string
    name: string
    username: string
    username_filled: boolean
    password_filled: boolean
    frames: number
    passwordFields: number
  }
  candidates?: FillCandidateInfo[]
}

/** Login-fill capability slice. */
export interface LoginFillContext {
  /** The accounts that could fill the form on a tab. A locked vault pops the
   * native master-password bubble rather than failing. */
  loginCandidates: (params: { profileId?: string; tabId?: string }) => Promise<{
    profileId: string
    url: string
    host: string
    candidates: FillCandidateInfo[]
  }>
  /** Fill a tab's login form from the vault. */
  fillLogin: (params: {
    profileId?: string
    tabId?: string
    id?: string
    username?: string
    ask?: boolean
  }) => Promise<FillResult>
}

/** An optional string param, or undefined when absent/empty. */
function opt(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

export const loginFillCommands: CommandMap<CommandContext> = {
  // Which accounts could log in on this page: { tabId?, profileId? }. Reads the
  // vault, touches nothing on the page, never returns a password.
  'login-candidates': async (ctx, params) => {
    const p = (params ?? {}) as { profileId?: unknown; tabId?: unknown }
    try {
      const profileId = opt(p.profileId)
      const tabId = opt(p.tabId)
      return {
        ok: true,
        ...(await ctx.loginCandidates({
          ...(profileId ? { profileId } : {}),
          ...(tabId ? { tabId } : {})
        }))
      }
    } catch (error) {
      return fail(error)
    }
  },

  // Fill the login form from the vault: { tabId?, profileId?, id?, username?,
  // ask? }. Answers `filled` when it filled, `candidates` when it needs to be
  // told which account — in which case nothing was typed into the page.
  //
  // Several accounts and no id/username: Mira opens its native picker in that
  // profile's window and fills what is chosen there. `ask:false` skips the
  // window and answers with the list — for a caller that must not block on a
  // human (a script, a test).
  'fill-login': async (ctx, params) => {
    const p = (params ?? {}) as {
      profileId?: unknown
      tabId?: unknown
      id?: unknown
      username?: unknown
      ask?: unknown
    }
    try {
      const profileId = opt(p.profileId)
      const tabId = opt(p.tabId)
      const id = opt(p.id)
      const username = opt(p.username)
      return {
        ok: true,
        ...(await ctx.fillLogin({
          ...(profileId ? { profileId } : {}),
          ...(tabId ? { tabId } : {}),
          ...(id ? { id } : {}),
          ...(username ? { username } : {}),
          ...(p.ask === false ? { ask: false } : {})
        }))
      }
    } catch (error) {
      return fail(error)
    }
  }
}
