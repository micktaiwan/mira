// Once a day, ask GitHub whether a newer Mira release exists, and say so once
// per version. Ported from Kova's src/update_check.rs — same policy, same state
// shape, so the two apps behave identically: the daily check stays silent unless
// there is a version it has not announced yet, and a check the user (or a script)
// asked for always answers, even "up to date".
//
// Everything here is pure or injected: the HTTP call, the clock, the state file
// and the way a result is shown are all deps, so the policy is unit-tested
// without Electron and without the network (Mira's "tout testable" principle).

/** A release version as a comparable triple. */
export type Version = [number, number, number]

/** What a check has to tell the user. */
export type Outcome =
  | { kind: 'newer'; version: Version }
  /** Only reported for a check that was asked for. */
  | { kind: 'up-to-date' }
  /** Only reported for a check that was asked for. */
  | { kind: 'failed'; error: string }

/** Persisted between runs, in `<userData>/update-check.json`. */
export interface UpdateState {
  /** Unix seconds of the last successful check. */
  lastCheck: number
  /** Last version the user was told about, so each release pops up once. */
  notifiedVersion: string | null
}

export const CHECK_INTERVAL_SECS = 24 * 3600
/** After a failed request (offline, rate limited), try again this much later
 * rather than waiting a whole day. */
export const RETRY_SECS = 3600

export const LATEST_RELEASE_URL = 'https://api.github.com/repos/micktaiwan/mira/releases/latest'

/** Parse `v1.10.0` or `1.10.0` into a triple. Missing components count as 0;
 * anything that is not a plain number (a `-beta` suffix, garbage) is refused, so
 * a pre-release tag never announces itself as an update. */
export function parseVersion(raw: string): Version | null {
  const text = raw.trim().replace(/^v/, '')
  if (text === '') return null
  const parts = text.split('.')
  if (parts.length > 3) return null
  const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN))
  if (nums.some((n) => Number.isNaN(n))) return null
  return [nums[0], nums[1] ?? 0, nums[2] ?? 0]
}

export function formatVersion(v: Version): string {
  return `${v[0]}.${v[1]}.${v[2]}`
}

/** Strictly-greater comparison, component by component (never string order:
 * "1.9.0" sorts after "1.10.0" as text). */
export function isNewer(latest: Version, current: Version): boolean {
  for (let i = 0; i < 3; i++) {
    if (latest[i] !== current[i]) return latest[i] > current[i]
  }
  return false
}

/** The release page, built from the PARSED version rather than from a URL the
 * API returned: the only thing ever handed to the shell is three numbers we
 * formatted ourselves. */
export function releasePage(v: Version): string {
  return `https://github.com/micktaiwan/mira/releases/tag/v${formatVersion(v)}`
}

/** What to tell the user once the latest release is known. */
export function outcomeFor(
  latest: Version,
  current: Version,
  notified: string | null,
  manual: boolean
): Outcome | null {
  if (isNewer(latest, current)) {
    const alreadyTold = notified !== null && sameVersion(parseVersion(notified), latest)
    if (manual || !alreadyTold) return { kind: 'newer', version: latest }
    return null
  }
  return manual ? { kind: 'up-to-date' } : null
}

function sameVersion(a: Version | null, b: Version): boolean {
  return a !== null && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
}

export interface UpdateCheckDeps {
  /** The running app's version (`app.getVersion()`). */
  currentVersion: string
  /** Fetch the latest release tag. Rejects with a readable message on failure. */
  fetchLatestTag: () => Promise<string>
  /** Unix seconds. Injected so the schedule is testable. */
  now: () => number
  loadState: () => UpdateState
  saveState: (state: UpdateState) => void
  /** Show the result. Returning a promise lets the caller await the dialog. */
  notify: (outcome: Outcome) => void | Promise<void>
  /** Optional log sink; defaults to console. */
  log?: (message: string) => void
}

const EMPTY_STATE: UpdateState = { lastCheck: 0, notifiedVersion: null }

/** Drives the schedule: `poll()` on a timer runs the check when it is due,
 * `checkNow()` runs one on demand and always answers. One request at a time. */
export class UpdateChecker {
  private state: UpdateState | null = null
  /** Unix seconds before which no automatic request is sent. In memory only, so
   * a failed request retries within the hour without being written to disk. */
  private nextAttempt: number | null = null
  private inFlight: Promise<void> | null = null

  constructor(private readonly deps: UpdateCheckDeps) {}

  /** Run a check now and report whatever it finds, including "up to date" and a
   * failure. Joins the in-flight request when one is already running.
   *
   * `observe` receives the same outcome the user is shown, so a caller (the
   * `check-for-updates` command) can answer its client with it instead of
   * re-deriving one. */
  async checkNow(observe?: (outcome: Outcome) => void): Promise<void> {
    return this.run(true, observe)
  }

  /** Called from a timer: start the daily check when it is due, and do nothing
   * otherwise. Never rejects. */
  async poll(): Promise<void> {
    if (this.inFlight) return
    if (this.nextAttempt === null) {
      this.nextAttempt = this.loaded().lastCheck + CHECK_INTERVAL_SECS
    }
    if (this.deps.now() < this.nextAttempt) return
    return this.run(false)
  }

  private async run(manual: boolean, observe?: (outcome: Outcome) => void): Promise<void> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.perform(manual, observe).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async perform(manual: boolean, observe?: (outcome: Outcome) => void): Promise<void> {
    const now = this.deps.now()
    let outcome: Outcome | null
    try {
      const tag = await this.deps.fetchLatestTag()
      const latest = parseVersion(tag)
      if (!latest) throw new Error(`unparsable tag ${JSON.stringify(tag)}`)
      const current = parseVersion(this.deps.currentVersion) ?? [0, 0, 0]
      const state = this.loaded()
      outcome = outcomeFor(latest, current, state.notifiedVersion, manual)
      this.write({ ...state, lastCheck: now })
      this.nextAttempt = now + CHECK_INTERVAL_SECS
      this.note(`update check: latest release is ${formatVersion(latest)}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.note(`update check failed, retrying in an hour: ${message}`)
      this.nextAttempt = now + RETRY_SECS
      outcome = manual ? { kind: 'failed', error: message } : null
    }
    if (!outcome) return
    observe?.(outcome)
    // Record the announcement BEFORE showing it: the dialog is awaited until the
    // user dismisses it, and a crash meanwhile must not re-announce the version.
    if (outcome.kind === 'newer') {
      const version = formatVersion(outcome.version)
      this.write({ ...this.loaded(), notifiedVersion: version })
    }
    await this.deps.notify(outcome)
  }

  private loaded(): UpdateState {
    if (!this.state) this.state = { ...EMPTY_STATE, ...this.deps.loadState() }
    return this.state
  }

  private write(state: UpdateState): void {
    this.state = state
    this.deps.saveState(state)
  }

  private note(message: string): void {
    if (this.deps.log) this.deps.log(message)
    else console.log(`[mira] ${message}`)
  }
}
