import { useEffect, useState } from 'react'

// The Settings view: a profile manager. It never mutates state directly — every
// action is a command sent to the main registry (list/create/rename/open),
// exactly like the browser chrome. See CLAUDE.md, "tout pilotable".

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

function Settings(): React.JSX.Element {
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
    // / socket elsewhere), so the list stays live without manual refetching.
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
    <div className="settings">
      <header className="settings-header">
        <h1>Profiles</h1>
        <button className="btn" onClick={create}>
          New profile
        </button>
      </header>
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

export default Settings
