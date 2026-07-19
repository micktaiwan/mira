// A profile's browsing trails — its history and its web-permission grant log —
// bundled with their debounced disk writes, extracted from the ProfileManager god
// object. The actual list surgery is delegated to the pure stores (history-store.ts
// / permission-store.ts); this class owns the in-memory lists, the two debounce
// timers, and the persistence wiring.
//
// TODAY there is ONE instance, shared by every profile (identical to the previous
// global-singleton behavior). It is deliberately shaped as a per-profile unit so
// the next step can instantiate ONE PER PROFILE and make history/permissions stop
// leaking across profiles — see track.md. Nothing window-bound lives here: the
// permission-grant broadcast is an injected callback (onPermissionsChanged), since
// pinging windows needs the window set the manager owns.

import {
  type HistoryEntry,
  recordVisit as recordVisitPure,
  recentHistory,
  searchHistory as searchHistoryPure,
  removeHistoryForDomain as removeHistoryForDomainPure
} from './history-store'
import {
  type PermissionGrant,
  recordGrant as recordGrantPure,
  listGrants
} from './permission-store'

export interface ProfileDataDeps {
  /** The persisted history at startup. */
  initialHistory: HistoryEntry[]
  /** Persist the full history list (debounced by this class). */
  persistHistory: (history: HistoryEntry[]) => void
  /** The persisted permission-grant log at startup. */
  initialPermissions: PermissionGrant[]
  /** Persist the full grant log (debounced by this class). */
  persistPermissions: (permissions: PermissionGrant[]) => void
  /** Nudge every window's chrome so an open Settings tab refetches the grant list.
   * Injected because pinging windows needs the manager's window set. */
  onPermissionsChanged: () => void
  /** Debounce for both disk flushes (ms). */
  debounceMs: number
  /** Clock, injectable so tests are deterministic. Defaults to Date.now. */
  now?: () => number
}

export class ProfileData {
  private history: HistoryEntry[]
  private permissions: PermissionGrant[]
  private historyTimer: ReturnType<typeof setTimeout> | null = null
  private permissionsTimer: ReturnType<typeof setTimeout> | null = null
  private readonly now: () => number

  constructor(private readonly deps: ProfileDataDeps) {
    this.history = deps.initialHistory
    this.permissions = deps.initialPermissions
    this.now = deps.now ?? Date.now
  }

  // --- History ---

  /** Record a page visit. Skips non-web urls (about:blank, mira://settings,
   * file://…) so only real browsing lands. Dedups by url (a re-visit bumps the
   * existing entry), then the write is debounced. */
  recordVisit(url: string, title: string): void {
    if (!/^https?:\/\//i.test(url)) return
    this.history = recordVisitPure(this.history, { url, title, at: this.now() })
    this.scheduleHistoryFlush()
  }

  /** The most recent history entries, newest first (for the history command). */
  listHistory(limit: number): HistoryEntry[] {
    return recentHistory(this.history, limit)
  }

  /** History entries matching `query` (url/title substring), newest first. */
  searchHistory(query: string, limit?: number): HistoryEntry[] {
    return searchHistoryPure(this.history, query, limit)
  }

  /** Wipe the history and write the empty list NOW (cancelling any pending flush),
   * so a clear is durable even if the app quits immediately after. */
  clearHistory(): { cleared: number } {
    const cleared = this.history.length
    this.history = []
    if (this.historyTimer) {
      clearTimeout(this.historyTimer)
      this.historyTimer = null
    }
    this.deps.persistHistory(this.history)
    return { cleared }
  }

  /** Drop every history entry belonging to the registrable domain `base` (the
   * base host and all its subdomains) and write NOW, cancelling any pending
   * flush so the removal is durable even if the app quits right after. Returns
   * how many entries were removed. Powers the "forget this site" deep clean. */
  removeHistoryForDomain(base: string): { removed: number } {
    const { list, removed } = removeHistoryForDomainPure(this.history, base)
    if (removed === 0) return { removed: 0 }
    this.history = list
    if (this.historyTimer) {
      clearTimeout(this.historyTimer)
      this.historyTimer = null
    }
    this.deps.persistHistory(this.history)
    return { removed }
  }

  private scheduleHistoryFlush(): void {
    if (this.historyTimer) return
    this.historyTimer = setTimeout(() => {
      this.historyTimer = null
      this.deps.persistHistory(this.history)
    }, this.deps.debounceMs)
  }

  // --- Permissions ---

  /** Record a granted permission, keyed by origin + permission (a re-grant bumps
   * the existing entry). Skips empty/opaque origins. The write is debounced, then
   * the Settings surface is nudged to refetch. */
  recordGrant(origin: string, permission: string): void {
    if (!origin || origin === 'null') return
    this.permissions = recordGrantPure(this.permissions, { origin, permission, at: this.now() })
    this.schedulePermissionsFlush()
    this.deps.onPermissionsChanged()
  }

  /** The grant log as a display-ready list (for the Settings permissions view). */
  listPermissions(): ReturnType<typeof listGrants> {
    return listGrants(this.permissions)
  }

  /** Wipe the grant log and write it NOW (cancelling any pending flush), then nudge
   * the Settings surface. Durable even on an immediate quit. */
  clearPermissions(): { cleared: number } {
    const cleared = this.permissions.length
    this.permissions = []
    if (this.permissionsTimer) {
      clearTimeout(this.permissionsTimer)
      this.permissionsTimer = null
    }
    this.deps.persistPermissions(this.permissions)
    this.deps.onPermissionsChanged()
    return { cleared }
  }

  private schedulePermissionsFlush(): void {
    if (this.permissionsTimer) return
    this.permissionsTimer = setTimeout(() => {
      this.permissionsTimer = null
      this.deps.persistPermissions(this.permissions)
    }, this.deps.debounceMs)
  }

  // --- Shutdown ---

  /** Cancel both pending debounced flushes and write the current lists now. Called
   * on app quit so the last few hundred ms of changes always land. */
  flush(): void {
    if (this.historyTimer) {
      clearTimeout(this.historyTimer)
      this.historyTimer = null
    }
    this.deps.persistHistory(this.history)
    if (this.permissionsTimer) {
      clearTimeout(this.permissionsTimer)
      this.permissionsTimer = null
    }
    this.deps.persistPermissions(this.permissions)
  }

  /** Cancel both pending debounced flushes WITHOUT writing. Used when an encrypted
   * profile locks: its plaintext files have just been copied into the vault and
   * wiped, so a lingering debounce timer must NOT fire and recreate them on disk
   * (that would leak decrypted trails past the lock). The instance is dropped right
   * after; the next unlock builds a fresh one from the restored files. */
  dispose(): void {
    if (this.historyTimer) {
      clearTimeout(this.historyTimer)
      this.historyTimer = null
    }
    if (this.permissionsTimer) {
      clearTimeout(this.permissionsTimer)
      this.permissionsTimer = null
    }
  }
}
