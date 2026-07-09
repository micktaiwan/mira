import { useEffect, useState } from 'react'

// The Settings surface, rendered inline as a Mira tab (App shows it when the
// active tab is the internal Settings tab). It never mutates state directly —
// every action is a command sent to the main registry (list/create/rename/open
// profiles, get-settings/set-home-url), exactly like the browser chrome. See
// CLAUDE.md, "tout pilotable". Organized into sub-sections (General / Profiles).

interface Profile {
  id: string
  label: string
  open: boolean
}

/** Thin wrapper around the command bus; every command returns a result object
 * shaped { ok, ... } or { ok: false, error }. */
async function run(name: string, params?: unknown): Promise<Record<string, unknown>> {
  return (await window.mira.command(name, params)) as Record<string, unknown>
}

type Section = 'general' | 'profiles'

/** The "General" sub-section: app-wide settings. Currently just the home page URL
 * (the address a new tab / fresh window opens on). */
function GeneralSection(): React.JSX.Element {
  const [homeUrl, setHomeUrl] = useState('')
  const [saved, setSaved] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const load = async (): Promise<void> => {
      const res = await run('get-settings')
      if (!res.ok) return
      const url = String(res.homeUrl ?? '')
      setHomeUrl(url)
      setSaved(url)
    }
    void load()
  }, [])

  const commit = async (): Promise<void> => {
    const trimmed = homeUrl.trim()
    // Nothing to do if unchanged or blank (the command would reject blank anyway).
    if (trimmed === '' || trimmed === saved) {
      setHomeUrl(saved)
      return
    }
    const res = await run('set-home-url', { url: trimmed })
    if (res.ok) {
      // Reflect the normalized value main stored (bare host → https://…).
      const url = String(res.homeUrl ?? trimmed)
      setHomeUrl(url)
      setSaved(url)
      setError(null)
    } else {
      setError(String(res.error))
      setHomeUrl(saved)
    }
  }

  return (
    <div className="settings-section">
      <label className="settings-field">
        <span className="settings-field-label">Home page</span>
        <input
          className="settings-input"
          type="text"
          value={homeUrl}
          onChange={(e) => setHomeUrl(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              setHomeUrl(saved)
              e.currentTarget.blur()
            }
          }}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="https://example.com"
          aria-label="Home page URL"
        />
      </label>
      <p className="settings-hint">The address a new tab and a fresh window open on.</p>
      {error && <p className="settings-error">{error}</p>}
    </div>
  )
}

function ProfileRow({
  profile,
  focused,
  onRename,
  onOpen
}: {
  profile: Profile
  focused: boolean
  onRename: (label: string) => void
  onOpen: () => void
}): React.JSX.Element {
  // Local draft, seeded from the prop. The parent remounts this row (via key)
  // when the committed label changes, so no prop-sync effect is needed.
  const [label, setLabel] = useState(profile.label)
  const status = profile.open ? (focused ? 'focused' : 'open') : 'closed'

  return (
    <li className="profile-row">
      <input
        className="profile-label-input"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={() => onRename(label)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setLabel(profile.label)
            e.currentTarget.blur()
          }
        }}
        spellCheck={false}
        aria-label="Profile name"
      />
      <span className={`profile-status status-${status}`}>{status}</span>
      <button className="btn btn-ghost" onClick={onOpen}>
        {profile.open ? 'Focus' : 'Open'}
      </button>
    </li>
  )
}

/** The "Profiles" sub-section: the profile manager (list / create / rename / open). */
function ProfilesSection(): React.JSX.Element {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [focused, setFocused] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const load = async (): Promise<void> => {
      const res = await run('list-profiles')
      if (!res.ok) return
      setProfiles((res.profiles as Profile[]) ?? [])
      setFocused((res.focused as string | null) ?? null)
    }
    void load()
    // Main pushes on every profile change (create/rename here, or from the menu
    // / socket / another window), so the list stays live without manual refetching.
    return window.mira.onProfilesChanged(load)
  }, [])

  const rename = async (id: string, label: string): Promise<void> => {
    const current = profiles.find((p) => p.id === id)
    const trimmed = label.trim()
    if (!current || trimmed === '' || trimmed === current.label) return
    const res = await run('rename-profile', { id, label: trimmed })
    setError(res.ok ? null : String(res.error))
  }

  const create = async (): Promise<void> => {
    const res = await run('create-profile')
    if (!res.ok) setError(String(res.error))
  }

  const open = (id: string): void => {
    void run('open-profile', { id })
  }

  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <button className="btn" onClick={create}>
          New profile
        </button>
      </div>
      <p className="settings-hint">
        A profile keeps its own cookies. Renaming changes the label only — the session is preserved.
      </p>
      {error && <p className="settings-error">{error}</p>}
      <ul className="profile-list">
        {profiles.map((p) => (
          <ProfileRow
            key={`${p.id}:${p.label}`}
            profile={p}
            focused={p.id === focused}
            onRename={(label) => rename(p.id, label)}
            onOpen={() => open(p.id)}
          />
        ))}
      </ul>
    </div>
  )
}

const SECTIONS: Array<{ key: Section; label: string }> = [
  { key: 'general', label: 'General' },
  { key: 'profiles', label: 'Profiles' }
]

function Settings(): React.JSX.Element {
  const [section, setSection] = useState<Section>('general')

  return (
    <div className="settings">
      <header className="settings-header">
        <h1>Settings</h1>
      </header>
      <nav className="settings-tabs" role="tablist">
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            role="tab"
            aria-selected={section === s.key}
            className={`settings-tab${section === s.key ? ' active' : ''}`}
            onClick={() => setSection(s.key)}
          >
            {s.label}
          </button>
        ))}
      </nav>
      {section === 'general' ? <GeneralSection /> : <ProfilesSection />}
    </div>
  )
}

export default Settings
