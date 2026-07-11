import { useEffect, useState } from 'react'

// The Settings surface, rendered inline as a Mira tab (App shows it when the
// active tab is the internal Settings tab). It never mutates state directly —
// every action is a command sent to the main registry (list/create/rename/open
// profiles, get-settings/set-home-url), exactly like the browser chrome. See
// CLAUDE.md, "tout pilotable". Organized into sub-sections (General / Profiles).

interface Profile {
  id: string
  label: string
  /** Theme color (#rrggbb) tinting the profile window's chrome, if set. */
  color?: string
  open: boolean
}

/** Preset theme colors offered per profile. Must match PROFILE_COLORS in
 * src/main/profile-store.ts (the model also accepts any hex via the bus). */
const PROFILE_COLORS = [
  '#4d7cfe',
  '#8b5cf6',
  '#ec4899',
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#14b8a6'
]

/** Thin wrapper around the command bus; every command returns a result object
 * shaped { ok, ... } or { ok: false, error }. */
async function run(name: string, params?: unknown): Promise<Record<string, unknown>> {
  return (await window.mira.command(name, params)) as Record<string, unknown>
}

type Section = 'general' | 'ai' | 'profiles' | 'extensions' | 'permissions' | 'data'

type LlmProvider = 'claude-cli' | 'anthropic-api' | 'extractive'

interface LlmConfig {
  provider: LlmProvider
  apiKey?: string
  model?: string
}

const PROVIDER_LABELS: Record<LlmProvider, string> = {
  'claude-cli': 'Claude subscription (claude -p)',
  'anthropic-api': 'Anthropic API key',
  extractive: 'Local (extractive, no AI)'
}

/** The "AI" sub-section: which engine skills use to summarize. Three providers —
 * the logged-in Claude subscription via `claude -p` (no key), the Anthropic API
 * (needs a key), or the local extractive fallback. */
function AiSection(): React.JSX.Element {
  const [config, setConfig] = useState<LlmConfig>({ provider: 'claude-cli' })
  const [saved, setSaved] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const load = async (): Promise<void> => {
      const res = await run('get-settings')
      if (!res.ok || !res.llm) return
      setConfig(res.llm as LlmConfig)
    }
    void load()
  }, [])

  const save = async (next: LlmConfig): Promise<void> => {
    const res = await run('set-llm-config', next)
    if (res.ok) {
      setConfig((res.llm as LlmConfig) ?? next)
      setSaved('Saved.')
      setError(null)
    } else {
      setError(String(res.error))
    }
  }

  const onProvider = (provider: LlmProvider): void => {
    const next = { ...config, provider }
    setConfig(next)
    void save(next)
  }

  return (
    <div className="settings-section">
      <label className="settings-field">
        <span className="settings-field-label">Engine</span>
        <select
          className="settings-input"
          value={config.provider}
          onChange={(e) => onProvider(e.target.value as LlmProvider)}
          aria-label="AI engine"
        >
          {(Object.keys(PROVIDER_LABELS) as LlmProvider[]).map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABELS[p]}
            </option>
          ))}
        </select>
      </label>
      <p className="settings-hint">
        The engine skills use to summarize. The Claude subscription option runs the local{' '}
        <code>claude</code> CLI in print mode (no key, uses your plan). The API option calls
        Anthropic directly with the key below. Local does a plain extractive summary — no AI, no
        network.
      </p>

      {config.provider === 'anthropic-api' && (
        <label className="settings-field">
          <span className="settings-field-label">Anthropic API key</span>
          <input
            className="settings-input"
            type="password"
            value={config.apiKey ?? ''}
            onChange={(e) => setConfig({ ...config, apiKey: e.target.value })}
            onBlur={() => void save(config)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
            spellCheck={false}
            autoComplete="off"
            placeholder="sk-ant-…"
            aria-label="Anthropic API key"
          />
        </label>
      )}

      {config.provider !== 'extractive' && (
        <label className="settings-field">
          <span className="settings-field-label">Model (optional)</span>
          <input
            className="settings-input"
            type="text"
            value={config.model ?? ''}
            onChange={(e) => setConfig({ ...config, model: e.target.value })}
            onBlur={() => void save(config)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
            spellCheck={false}
            autoComplete="off"
            placeholder="Leave empty for the default"
            aria-label="Model"
          />
        </label>
      )}

      {saved && !error && <p className="settings-hint">{saved}</p>}
      {error && <p className="settings-error">{error}</p>}
    </div>
  )
}

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
    // Nothing to do if unchanged. An empty value is a real choice (clear the home
    // so new tabs open blank), so it goes through to the command.
    if (trimmed === saved) {
      setHomeUrl(saved)
      return
    }
    const res = await run('set-home-url', { url: trimmed })
    if (res.ok) {
      // Reflect the normalized value main stored (bare host → https://…, or '').
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
          placeholder="Leave empty for a blank page"
          aria-label="Home page URL"
        />
      </label>
      <p className="settings-hint">
        The address a new tab and a fresh window open on. Leave empty to open a blank page.
      </p>
      {error && <p className="settings-error">{error}</p>}
    </div>
  )
}

function ProfileRow({
  profile,
  focused,
  onRename,
  onSetColor,
  onOpen
}: {
  profile: Profile
  focused: boolean
  onRename: (label: string) => void
  onSetColor: (color: string | null) => void
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
      <div className="profile-colors" role="radiogroup" aria-label="Theme color">
        {PROFILE_COLORS.map((color) => (
          <button
            key={color}
            role="radio"
            aria-checked={profile.color === color}
            className={`profile-color-swatch${profile.color === color ? ' selected' : ''}`}
            style={{ '--swatch-color': color } as React.CSSProperties}
            title={color}
            aria-label={`Theme color ${color}`}
            onClick={() => onSetColor(profile.color === color ? null : color)}
          />
        ))}
        <button
          role="radio"
          aria-checked={!profile.color}
          className={`profile-color-swatch profile-color-none${profile.color ? '' : ' selected'}`}
          title="No color"
          aria-label="No theme color"
          onClick={() => onSetColor(null)}
        />
      </div>
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

  const setColor = async (id: string, color: string | null): Promise<void> => {
    // Main persists, re-tints the profile's open window live, and pushes
    // profiles-changed — which refetches this list, updating the swatches.
    const res = await run('set-profile-color', { id, color })
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
        The theme color tints the profile window&apos;s chrome, so windows are tellable apart.
      </p>
      {error && <p className="settings-error">{error}</p>}
      <ul className="profile-list">
        {profiles.map((p) => (
          <ProfileRow
            key={`${p.id}:${p.label}`}
            profile={p}
            focused={p.id === focused}
            onRename={(label) => rename(p.id, label)}
            onSetColor={(color) => void setColor(p.id, color)}
            onOpen={() => open(p.id)}
          />
        ))}
      </ul>
    </div>
  )
}

/** The "Data" sub-section: wipe the current profile's browsing data (cookies,
 * cache, storage). Destructive, so it uses a two-step confirm. */
function DataSection(): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const clear = async (): Promise<void> => {
    setConfirming(false)
    setStatus(null)
    setError(null)
    // No `profile` param: main clears this window's own profile session.
    const res = await run('clear-data')
    if (res.ok) setStatus('Browsing data cleared. Reload open tabs to see the effect.')
    else setError(String(res.error))
  }

  return (
    <div className="settings-section">
      <div className="settings-section-head">
        {confirming ? (
          <>
            <button className="btn btn-danger" onClick={clear}>
              Clear everything
            </button>
            <button className="btn btn-ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button className="btn btn-danger" onClick={() => setConfirming(true)}>
            Clear browsing data
          </button>
        )}
      </div>
      <p className="settings-hint">
        Wipes cookies, cache and site storage for this profile — a full sign-out. Other profiles are
        untouched. This cannot be undone.
      </p>
      {status && <p className="settings-hint">{status}</p>}
      {error && <p className="settings-error">{error}</p>}
    </div>
  )
}

interface ExtensionInfo {
  id: string
  name: string
  version: string
  path: string
  /** false = paused: unloaded from the session but kept on disk. */
  enabled: boolean
}

/** The "Extensions" sub-section: the extensions of THIS window's profile
 * (extension sets are per profile — installing in one leaves the others
 * untouched). Install happens by browsing the Chrome Web Store or via
 * `load-extension {path}` (socket) for an unpacked dir; here: list, update,
 * remove. The list is fetched on mount (the section remounts on each tab
 * switch), and refreshed after every action. */
function ExtensionsSection(): React.JSX.Element {
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Bumped after every action; the fetch effect below re-runs on it.
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    const load = async (): Promise<void> => {
      const res = await run('list-extensions')
      if (res.ok) setExtensions((res.extensions as ExtensionInfo[]) ?? [])
      else setError(String(res.error))
    }
    void load()
  }, [refreshKey])

  const remove = async (ext: ExtensionInfo): Promise<void> => {
    setStatus(null)
    setError(null)
    const res = await run('uninstall-extension', { id: ext.id })
    if (res.ok) setStatus(`Removed ${ext.name}.`)
    else setError(String(res.error))
    setRefreshKey((k) => k + 1)
  }

  // Pause (unload without uninstalling) or resume an extension.
  const toggle = async (ext: ExtensionInfo): Promise<void> => {
    setStatus(null)
    setError(null)
    const command = ext.enabled ? 'disable-extension' : 'enable-extension'
    const res = await run(command, { id: ext.id })
    if (res.ok) setStatus(`${ext.enabled ? 'Disabled' : 'Enabled'} ${ext.name}.`)
    else setError(String(res.error))
    setRefreshKey((k) => k + 1)
  }

  const update = async (): Promise<void> => {
    setStatus(null)
    setError(null)
    const res = await run('update-extensions')
    if (res.ok) setStatus('Checked the Chrome Web Store for updates.')
    else setError(String(res.error))
    setRefreshKey((k) => k + 1)
  }

  return (
    <div className="settings-section">
      <p className="settings-hint">
        Extensions of this profile only — each profile has its own set. Install by browsing the
        Chrome Web Store, right here in Mira.
      </p>
      {extensions.length > 0 && (
        <div className="settings-section-head">
          <button className="btn btn-ghost" onClick={update}>
            Check for updates
          </button>
        </div>
      )}
      {status && <p className="settings-hint">{status}</p>}
      {error && <p className="settings-error">{error}</p>}
      {extensions.length === 0 ? (
        <p className="settings-hint">No extensions installed in this profile.</p>
      ) : (
        <ul className="extension-list">
          {extensions.map((ext) => (
            <li key={ext.id} className={`extension-row${ext.enabled ? '' : ' disabled'}`}>
              <span className="extension-name">{ext.name}</span>
              {!ext.enabled && <span className="extension-state">disabled</span>}
              <span className="extension-version">{ext.version}</span>
              <button className="btn btn-ghost" onClick={() => toggle(ext)}>
                {ext.enabled ? 'Disable' : 'Enable'}
              </button>
              <button className="btn btn-danger" onClick={() => remove(ext)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

interface PermissionGrant {
  origin: string
  permission: string
  firstGranted: number
  lastGranted: number
  count: number
}

/** The "Permissions" sub-section: the log of what Mira granted to which site.
 * Mira grants every web permission automatically (personal browser, single
 * trusted user), so this is a transparency view, not a toggle list — it shows
 * what has actually been used, newest first, and can be cleared. */
function PermissionsSection(): React.JSX.Element {
  const [grants, setGrants] = useState<PermissionGrant[]>([])

  useEffect(() => {
    const load = async (): Promise<void> => {
      const res = await run('list-permissions')
      if (res.ok) setGrants((res.grants as PermissionGrant[]) ?? [])
    }
    void load()
    // Main pings on every new grant (a page requesting a permission), so the list
    // stays live while Settings is open.
    return window.mira.onPermissionsChanged(load)
  }, [])

  const clear = async (): Promise<void> => {
    const res = await run('clear-permissions')
    if (res.ok) setGrants([])
  }

  return (
    <div className="settings-section">
      <p className="settings-hint">
        Mira grants every site permission automatically (geolocation, notifications, …). This is the
        record of what was granted, so nothing happens invisibly.
      </p>
      {grants.length > 0 && (
        <div className="settings-section-head">
          <button className="btn btn-ghost" onClick={clear}>
            Clear log
          </button>
        </div>
      )}
      {grants.length === 0 ? (
        <p className="settings-hint">No site has requested a permission yet.</p>
      ) : (
        <ul className="permission-list">
          {grants.map((g) => (
            <li key={`${g.origin} ${g.permission}`} className="permission-row">
              <span className="permission-kind">{g.permission}</span>
              <span className="permission-origin">{g.origin}</span>
              <span className="permission-when">{new Date(g.lastGranted).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const SECTIONS: Array<{ key: Section; label: string }> = [
  { key: 'general', label: 'General' },
  { key: 'ai', label: 'AI' },
  { key: 'profiles', label: 'Profiles' },
  { key: 'extensions', label: 'Extensions' },
  { key: 'permissions', label: 'Permissions' },
  { key: 'data', label: 'Data' }
]

/** The shown sub-section is NOT local state: it lives in the settings tab's url
 * (mira://settings/<section>), owned by main. `section` is that url's section,
 * passed down by App; clicking a panel tab sends open-settings with the new
 * section, main updates the tab url, and the fresh state flows back down. So
 * the chrome://extensions alias, the palette, the socket and a plain click all
 * drive the panel the same way. Unknown/missing names show General. */
function Settings({ section: requested }: { section?: string }): React.JSX.Element {
  const section: Section = SECTIONS.some((s) => s.key === requested)
    ? (requested as Section)
    : 'general'

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
            onClick={() => run('open-settings', { section: s.key })}
          >
            {s.label}
          </button>
        ))}
      </nav>
      {section === 'general' && <GeneralSection />}
      {section === 'ai' && <AiSection />}
      {section === 'profiles' && <ProfilesSection />}
      {section === 'extensions' && <ExtensionsSection />}
      {section === 'permissions' && <PermissionsSection />}
      {section === 'data' && <DataSection />}
    </div>
  )
}

export default Settings
