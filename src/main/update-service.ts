// Electron wiring for the daily update check: the network call, the state file,
// and how a result reaches the user. The policy itself (when to check, what to
// say, once per version) is pure and tested in update-check.ts.
//
// The notice is a native macOS notification, not a dialog: Mira is scripted
// continuously and must never jump in front of whatever the user is doing
// (foreground-policy.ts). Clicking the notification opens the release page.

import { Notification, app, shell } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  LATEST_RELEASE_URL,
  UpdateChecker,
  formatVersion,
  releasePage,
  type Outcome,
  type UpdateState
} from './update-check'

/** How often the timer asks the checker whether the daily check is due. The
 * check itself is rate-limited by the checker, so this only decides how soon
 * after the 24 h mark it fires. */
export const POLL_INTERVAL_MS = 10 * 60 * 1000

const EMPTY: UpdateState = { lastCheck: 0, notifiedVersion: null }

function statePath(): string {
  return join(app.getPath('userData'), 'update-check.json')
}

function loadState(): UpdateState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<UpdateState>
    return {
      lastCheck: typeof parsed.lastCheck === 'number' ? parsed.lastCheck : 0,
      notifiedVersion: typeof parsed.notifiedVersion === 'string' ? parsed.notifiedVersion : null
    }
  } catch {
    // No file yet, or an unreadable one: start over rather than block the check.
    return { ...EMPTY }
  }
}

function saveState(state: UpdateState): void {
  const path = statePath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`)
  } catch (error) {
    console.error('[mira] update check: cannot write state:', error)
  }
}

/** Ask GitHub for the latest release tag. A 404 is the normal answer for a repo
 * with no release yet, and says so in as many words — the caller logs it and
 * retries in an hour like any other failure. */
async function fetchLatestTag(): Promise<string> {
  const response = await fetch(LATEST_RELEASE_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `Mira/${app.getVersion()}`
    },
    signal: AbortSignal.timeout(15_000)
  })
  if (response.status === 404) throw new Error('no release published yet')
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
  const body = (await response.json()) as { tag_name?: unknown }
  if (typeof body.tag_name !== 'string') throw new Error('unexpected response: no tag_name')
  return body.tag_name
}

/** The notification text for an outcome, and the page a click opens. */
export function noticeFor(
  outcome: Outcome,
  current: string
): { title: string; body: string; open?: string } {
  switch (outcome.kind) {
    case 'newer':
      return {
        title: `Mira ${formatVersion(outcome.version)} is available`,
        body: `You are running Mira ${current}. Click to see the release.`,
        open: releasePage(outcome.version)
      }
    case 'up-to-date':
      return { title: 'Mira is up to date', body: `Mira ${current} is the latest release.` }
    case 'failed':
      return { title: 'Could not check for updates', body: outcome.error }
  }
}

function show(outcome: Outcome): void {
  const notice = noticeFor(outcome, app.getVersion())
  if (!Notification.isSupported()) {
    console.log(`[mira] ${notice.title} — ${notice.body}`)
    return
  }
  const notification = new Notification({ title: notice.title, body: notice.body, silent: true })
  if (notice.open) {
    const page = notice.open
    notification.on('click', () => {
      shell.openExternal(page).catch((error) => console.error('[mira] open release page', error))
    })
  }
  notification.show()
}

/** Build the checker Mira actually runs. */
export function createUpdateChecker(): UpdateChecker {
  return new UpdateChecker({
    currentVersion: app.getVersion(),
    fetchLatestTag,
    now: () => Math.floor(Date.now() / 1000),
    loadState,
    saveState,
    notify: show
  })
}

/** Start the daily schedule: one poll now (so a Mira left running for days still
 * checks, and one launched after a long sleep checks at once), then every
 * POLL_INTERVAL_MS. The timer is unref'd so it never holds the app alive. */
export function startUpdateSchedule(checker: UpdateChecker): NodeJS.Timeout {
  const tick = (): void => {
    checker.poll().catch((error) => console.error('[mira] update check:', error))
  }
  tick()
  const timer = setInterval(tick, POLL_INTERVAL_MS)
  timer.unref?.()
  return timer
}
