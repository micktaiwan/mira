import { useEffect, useState } from 'react'
import { timeAgo } from './time-ago'

// Settings → Audio: every open tab that has emitted sound, most recent first
// (list-audio-history). Clicking a row brings that tab to the front through
// activate-tab, the same command a socket client would use.

/** Mirrors AudioHistoryEntry in src/main/commands/audio-history.ts. */
interface AudioHistoryEntry {
  tabId: string
  profileId: string
  profileLabel: string
  title: string
  url: string
  favicon: string | null
  lastAudibleAt: number
  audible: boolean
}

async function run(name: string, params?: unknown): Promise<Record<string, unknown>> {
  return (await window.mira.command(name, params)) as Record<string, unknown>
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

export function AudioHistorySection(): React.JSX.Element {
  const [entries, setEntries] = useState<AudioHistoryEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // Reads the list; every setState happens in the promise callback, never
  // synchronously in the effect that triggers it.
  const load = (): void => {
    void run('list-audio-history').then((res) => {
      if (res.ok) {
        setEntries((res.entries as AudioHistoryEntry[]) ?? [])
        setError(null)
      } else {
        setError(String(res.error))
      }
      setNow(Date.now())
    })
  }

  const focus = async (tabId: string): Promise<void> => {
    const res = await run('activate-tab', { id: tabId })
    if (!res.ok) setError(String(res.error))
  }

  useEffect(() => {
    load()
    // A sound starting or stopping pushes this window's tab strip; a profile
    // opening or closing changes which tabs exist. Both re-read the list, and a
    // slow tick keeps the "x min ago" labels honest (and catches other windows).
    const offTabs = window.mira.onTabsChanged(load)
    const offProfiles = window.mira.onProfilesChanged(load)
    const tick = setInterval(load, 30_000)
    return () => {
      offTabs()
      offProfiles()
      clearInterval(tick)
    }
  }, [])

  return (
    <div className="settings-section">
      <p className="settings-hint">
        Every open tab that has played sound, most recent first. Click a tab to go to it.
      </p>
      {error && <p className="settings-error">{error}</p>}
      {entries.length === 0 ? (
        <p className="settings-hint">No tab has played sound yet.</p>
      ) : (
        <table className="tab-mem-table">
          <thead>
            <tr>
              <th>Tab</th>
              <th>Profile</th>
              <th className="tab-mem-size">Last sound</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.tabId} className="audio-history-row" onClick={() => void focus(e.tabId)}>
                <td className="tab-mem-tab">
                  <div className="tab-mem-title-row">
                    {e.favicon ? (
                      <img className="tab-mem-favicon" src={e.favicon} alt="" />
                    ) : (
                      <span className="tab-mem-favicon tab-mem-favicon-blank" />
                    )}
                    <span className="tab-mem-title" title={e.title}>
                      {e.title || 'Untitled'}
                    </span>
                  </div>
                  <span className="tab-mem-host">{hostOf(e.url)}</span>
                </td>
                <td className="tab-mem-profile">{e.profileLabel}</td>
                <td className="tab-mem-size" title={new Date(e.lastAudibleAt).toLocaleString()}>
                  {e.audible ? <strong>Playing now</strong> : timeAgo(e.lastAudibleAt, now)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
