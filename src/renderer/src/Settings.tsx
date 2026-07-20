import { useEffect, useState } from 'react'

// The Settings surface, rendered inline as a Mira tab (App shows it when the
// active tab is the internal Settings tab). It never mutates state directly —
// every action is a command sent to the main registry (list/create/rename/open
// profiles, get-settings/set-home-url), exactly like the browser chrome. See
// CLAUDE.md, "tout pilotable". Organized into sub-sections (General / Profiles).

interface Profile {
  id: string
  label: string
  /** The id of the chrome theme this profile uses (see theme-store.ts). */
  themeId?: string
  /** Legacy tint color (#rrggbb) for pre-themes profiles. */
  color?: string
  open: boolean
}

/** A chrome theme as returned by list-themes. */
interface ThemeItem {
  id: string
  name: string
  background: string
  text: string
  accent?: string
  wallpaper?: string
  builtin?: boolean
}

const DEFAULT_THEME_ID = 'midnight'

/** Thin wrapper around the command bus; every command returns a result object
 * shaped { ok, ... } or { ok: false, error }. */
async function run(name: string, params?: unknown): Promise<Record<string, unknown>> {
  return (await window.mira.command(name, params)) as Record<string, unknown>
}

type Section = 'general' | 'ai' | 'profiles' | 'tabs' | 'extensions' | 'permissions' | 'data'

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
  encrypted,
  unlocked,
  themes,
  onRename,
  onSetTheme,
  onOpen,
  onEncrypt,
  onUnlock,
  onLock
}: {
  profile: Profile
  focused: boolean
  /** This profile is password-protected (its data lives in a vault at rest). */
  encrypted: boolean
  /** An encrypted profile currently unlocked this session (plaintext live). */
  unlocked: boolean
  /** Every available theme (built-ins + custom), for the per-profile picker. */
  themes: ThemeItem[]
  onRename: (label: string) => void
  onSetTheme: (themeId: string) => void
  onOpen: () => void
  onEncrypt: () => void
  onUnlock: () => void
  onLock: () => void
}): React.JSX.Element {
  // Local draft, seeded from the prop. The parent remounts this row (via key)
  // when the committed label changes, so no prop-sync effect is needed.
  const [label, setLabel] = useState(profile.label)
  const status = profile.open ? (focused ? 'focused' : 'open') : 'closed'
  // The theme this profile currently resolves to (its themeId, else the default),
  // for the picker's value and preview dot.
  const currentTheme = themes.find((t) => t.id === profile.themeId) ??
    themes.find((t) => t.id === DEFAULT_THEME_ID) ??
    themes[0] ?? { id: DEFAULT_THEME_ID, name: 'Midnight', background: '#1b1b1f', text: '#ebebeb' }

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
      <div className="profile-theme-pick">
        <span
          className="profile-theme-dot"
          style={
            {
              '--dot-bg': currentTheme.background,
              '--dot-fg': currentTheme.text
            } as React.CSSProperties
          }
          aria-hidden
        />
        <select
          className="profile-theme-select"
          value={currentTheme.id}
          aria-label="Chrome theme"
          onChange={(e) => onSetTheme(e.target.value)}
        >
          {themes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <span className={`profile-status status-${status}`}>{status}</span>
      {/* Fixed trailing slots so every row shares the same columns (a row missing
          the Encrypt button must not shift its neighbours' alignment). */}
      <span className="profile-badge-slot">
        {encrypted && (
          <span className={`vault-badge ${unlocked ? 'unlocked' : 'locked'}`}>
            {unlocked ? '🔓 Unlocked' : '🔒 Locked'}
          </span>
        )}
      </span>
      <span className="profile-action-slot">
        {/* Encrypt: only a plaintext, non-default profile. The default profile has no
            self-contained dir to vault. Disabled while its window is open (encrypt
            needs the partition's handles released). */}
        {!encrypted && profile.id !== 'default' && (
          <button
            className="btn btn-ghost"
            onClick={onEncrypt}
            disabled={profile.open}
            title={profile.open ? 'Close its window first' : 'Encrypt this profile'}
          >
            Encrypt
          </button>
        )}
        {encrypted && !unlocked && (
          <button className="btn" onClick={onUnlock}>
            Unlock
          </button>
        )}
        {encrypted && unlocked && (
          <button
            className="btn btn-ghost"
            onClick={onLock}
            disabled={profile.open}
            title={profile.open ? 'Close its window first' : 'Lock this profile'}
          >
            Lock
          </button>
        )}
      </span>
      <span className="profile-action-slot">
        {/* Open / Focus — hidden while locked (there is nothing to open until unlock). */}
        {(!encrypted || unlocked) && (
          <button className="btn btn-ghost" onClick={onOpen}>
            {profile.open ? 'Focus' : 'Open'}
          </button>
        )}
      </span>
    </li>
  )
}

/** A password prompt for encrypting or unlocking a profile. Chrome UI (rendered
 * inside the Settings tab, not over web content), so a plain overlay is fine.
 * onSubmit returns an error string to show inline, or null on success (then close). */
function VaultPasswordDialog({
  mode,
  profileLabel,
  onSubmit,
  onClose
}: {
  mode: 'encrypt' | 'unlock'
  profileLabel: string
  onSubmit: (password: string) => Promise<string | null>
  onClose: () => void
}): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    if (password.length === 0) {
      setError('Enter a password')
      return
    }
    if (mode === 'encrypt' && password !== confirm) {
      setError('Passwords do not match')
      return
    }
    setBusy(true)
    const err = await onSubmit(password)
    setBusy(false)
    if (err) setError(err)
    else onClose()
  }

  return (
    <div className="vault-overlay" onClick={onClose}>
      <div className="vault-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>
          {mode === 'encrypt' ? 'Encrypt' : 'Unlock'} “{profileLabel}”
        </h3>
        <p>
          {mode === 'encrypt'
            ? 'This profile’s cookies, storage and history will be encrypted at rest. There is no recovery: if you forget this password, the data is lost.'
            : 'Enter the password to unlock this profile for this session.'}
        </p>
        <input
          className="vault-input"
          type="password"
          autoFocus
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && mode === 'unlock') void submit()
          }}
        />
        {mode === 'encrypt' && (
          <input
            className="vault-input"
            type="password"
            placeholder="Confirm password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
          />
        )}
        {error && <p className="vault-error">{error}</p>}
        <div className="vault-actions">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Working…' : mode === 'encrypt' ? 'Encrypt' : 'Unlock'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Theme manager under the profile list: create a theme from a name + two colors
 * (+ an optional wallpaper URL), and delete custom ones. Built-ins are read-only.
 * Every action is a command (create-theme / delete-theme); main pushes
 * profiles-changed so the parent refetches the theme list. */
function ThemesManager({
  themes,
  onError
}: {
  themes: ThemeItem[]
  onError: (msg: string | null) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [background, setBackground] = useState('#12141a')
  const [text, setText] = useState('#e8e8ea')
  const [accent, setAccent] = useState('#6988e6')
  const [wallpaper, setWallpaper] = useState('')

  const create = async (): Promise<void> => {
    if (name.trim() === '') {
      onError('Give the theme a name')
      return
    }
    const res = await run('create-theme', {
      name: name.trim(),
      background,
      text,
      accent,
      wallpaper: wallpaper.trim() || null
    })
    if (!res.ok) {
      onError(String(res.error))
      return
    }
    onError(null)
    setName('')
    setWallpaper('')
    setOpen(false)
  }

  const remove = async (id: string): Promise<void> => {
    const res = await run('delete-theme', { id })
    onError(res.ok ? null : String(res.error))
  }

  return (
    <div className="themes-manager">
      <div className="themes-head">
        <h2 className="themes-title">Themes</h2>
        <button className="btn btn-ghost" onClick={() => setOpen((o) => !o)}>
          {open ? 'Close' : 'New theme'}
        </button>
      </div>
      {open && (
        <div className="theme-form">
          <input
            className="settings-input"
            placeholder="Theme name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            spellCheck={false}
          />
          <div className="theme-form-colors">
            <label className="theme-color-field">
              Background
              <input
                type="color"
                value={background}
                onChange={(e) => setBackground(e.target.value)}
              />
            </label>
            <label className="theme-color-field">
              Text
              <input type="color" value={text} onChange={(e) => setText(e.target.value)} />
            </label>
            <label className="theme-color-field">
              Accent
              <input type="color" value={accent} onChange={(e) => setAccent(e.target.value)} />
            </label>
          </div>
          <input
            className="settings-input"
            placeholder="Wallpaper URL (optional, http/https)"
            value={wallpaper}
            onChange={(e) => setWallpaper(e.target.value)}
            spellCheck={false}
          />
          <div className="theme-form-actions">
            <button className="btn" onClick={() => void create()}>
              Create theme
            </button>
          </div>
        </div>
      )}
      <ul className="theme-list">
        {themes.map((t) => (
          <li key={t.id} className="theme-item">
            <span
              className="theme-swatch"
              style={
                {
                  '--sw-bg': t.background,
                  '--sw-fg': t.text,
                  '--sw-accent': t.accent ?? t.text
                } as React.CSSProperties
              }
            >
              Aa
            </span>
            <span className="theme-name">{t.name}</span>
            {t.builtin ? (
              <span className="theme-tag">built-in</span>
            ) : (
              <button className="btn btn-ghost" onClick={() => void remove(t.id)}>
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The "Profiles" sub-section: the profile manager (list / create / rename / open). */
function ProfilesSection(): React.JSX.Element {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [focused, setFocused] = useState<string | null>(null)
  const [themes, setThemes] = useState<ThemeItem[]>([])
  const [error, setError] = useState<string | null>(null)
  // Vault state, kept as sets for O(1) per-row lookup. Fetched alongside the
  // profile list (list-vaults is the runtime source of encrypted/unlocked).
  const [encrypted, setEncrypted] = useState<Set<string>>(new Set())
  const [unlocked, setUnlocked] = useState<Set<string>>(new Set())
  // The open password dialog, or null. Keyed to one profile + a mode.
  const [dialog, setDialog] = useState<{ mode: 'encrypt' | 'unlock'; profile: Profile } | null>(
    null
  )

  useEffect(() => {
    const load = async (): Promise<void> => {
      const [res, vaults, th] = await Promise.all([
        run('list-profiles'),
        run('list-vaults'),
        run('list-themes')
      ])
      if (res.ok) {
        setProfiles((res.profiles as Profile[]) ?? [])
        setFocused((res.focused as string | null) ?? null)
      }
      if (vaults.ok) {
        setEncrypted(new Set((vaults.encrypted as string[]) ?? []))
        setUnlocked(new Set((vaults.unlocked as string[]) ?? []))
      }
      if (th.ok) setThemes((th.themes as ThemeItem[]) ?? [])
    }
    void load()
    // Main pushes on every profile change (create/rename/encrypt/unlock/lock here,
    // or from the menu / socket / another window), so the list stays live.
    return window.mira.onProfilesChanged(load)
  }, [])

  const rename = async (id: string, label: string): Promise<void> => {
    const current = profiles.find((p) => p.id === id)
    const trimmed = label.trim()
    if (!current || trimmed === '' || trimmed === current.label) return
    const res = await run('rename-profile', { id, label: trimmed })
    setError(res.ok ? null : String(res.error))
  }

  const setTheme = async (id: string, themeId: string): Promise<void> => {
    // Main persists, repaints the profile's open windows live, and pushes
    // profiles-changed — which refetches this list.
    const res = await run('set-profile-theme', { id, themeId })
    setError(res.ok ? null : String(res.error))
  }

  const create = async (): Promise<void> => {
    const res = await run('create-profile')
    if (!res.ok) setError(String(res.error))
  }

  const open = (id: string): void => {
    void run('open-profile', { id })
  }

  const lock = async (id: string): Promise<void> => {
    const res = await run('lock-profile', { id })
    setError(res.ok ? null : String(res.error))
  }

  // The dialog's submit for both modes: run the command, return its error (shown
  // inline in the dialog) or null on success. On success the profiles-changed push
  // refetches the list, so the row updates on its own.
  const submitDialog = async (password: string): Promise<string | null> => {
    if (!dialog) return null
    const command = dialog.mode === 'encrypt' ? 'encrypt-profile' : 'unlock-profile'
    const res = await run(command, { id: dialog.profile.id, password })
    return res.ok ? null : String(res.error)
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
        Each profile paints its chrome with a theme, so windows are tellable apart. Encrypting a
        profile keeps its data in a password-protected vault at rest.
      </p>
      {error && <p className="settings-error">{error}</p>}
      <ul className="profile-list">
        {profiles.map((p) => (
          <ProfileRow
            key={`${p.id}:${p.label}`}
            profile={p}
            focused={p.id === focused}
            encrypted={encrypted.has(p.id)}
            unlocked={unlocked.has(p.id)}
            themes={themes}
            onRename={(label) => rename(p.id, label)}
            onSetTheme={(themeId) => void setTheme(p.id, themeId)}
            onOpen={() => open(p.id)}
            onEncrypt={() => setDialog({ mode: 'encrypt', profile: p })}
            onUnlock={() => setDialog({ mode: 'unlock', profile: p })}
            onLock={() => void lock(p.id)}
          />
        ))}
      </ul>
      <ThemesManager themes={themes} onError={setError} />
      {dialog && (
        <VaultPasswordDialog
          mode={dialog.mode}
          profileLabel={dialog.profile.label}
          onSubmit={submitDialog}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  )
}

/** One top-level entry under userData (mirrors DiskEntry in main). */
interface DiskEntry {
  name: string
  bytes: number
  reclaimable: boolean
}

/** A profile's footprint (mirrors ProfileDiskUsage in main). */
interface ProfileDiskUsage {
  id: string
  label: string
  encrypted: boolean
  partition: number
  reclaimable: number
  vault: number
  total: number
}

/** The disk-usage report (mirrors DiskUsageReport in main). */
interface DiskUsageReport {
  root: string
  total: number
  reclaimable: number
  entries: DiskEntry[]
  profiles: ProfileDiskUsage[]
}

/** Disk-usage analysis: Mira's on-disk footprint under userData, broken down by
 * top-level entry and by profile. Read-only (v1 analyses; clearing lives below).
 * Fetched on mount, with a manual refresh (the walk takes a moment). */
function DiskUsage(): React.JSX.Element {
  const [report, setReport] = useState<DiskUsageReport | null>(null)
  // Starts true so the first mount reads as "Scanning…"; the fetch flips it.
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    // All setState happens inside the async callback (never synchronously in the
    // effect body) so we don't trigger a cascading re-render.
    void run('disk-usage').then((res) => {
      if (cancelled) return
      if (res.ok) {
        setReport(res.usage as DiskUsageReport)
        setError(null)
      } else setError(String(res.error))
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  const refresh = (): void => {
    setLoading(true)
    setRefreshKey((k) => k + 1)
  }

  const max = report ? Math.max(1, ...report.entries.map((e) => e.bytes)) : 1

  return (
    <div className="disk-usage">
      <div className="settings-section-head">
        <h2 className="themes-title">Disk usage</h2>
        <button className="btn btn-ghost" onClick={refresh} disabled={loading}>
          {loading ? 'Scanning…' : 'Refresh'}
        </button>
      </div>
      {error && <p className="settings-error">{error}</p>}
      {report && (
        <>
          <p className="settings-hint">
            {formatBytes(report.total)} total, of which {formatBytes(report.reclaimable)} is
            regenerable cache (safe to clear). Sizes are approximate.
          </p>

          <h3 className="disk-subhead">By profile</h3>
          <ul className="disk-list">
            {report.profiles.map((p) => (
              <li key={p.id} className="disk-row">
                <span className="disk-name">
                  {p.label}
                  {p.encrypted && <span className="disk-tag">vault</span>}
                </span>
                <span className="disk-detail">
                  {p.vault > 0 && `${formatBytes(p.vault)} vault · `}
                  {formatBytes(p.reclaimable)} cache
                </span>
                <span className="disk-size">{formatBytes(p.total)}</span>
              </li>
            ))}
          </ul>

          <h3 className="disk-subhead">By folder</h3>
          <ul className="disk-list">
            {report.entries.map((e) => (
              <li key={e.name} className="disk-row">
                <span className="disk-name">
                  {e.name}
                  {e.reclaimable && <span className="disk-tag disk-tag-cache">cache</span>}
                </span>
                <span className="disk-bar-track">
                  <span
                    className={`disk-bar${e.reclaimable ? ' disk-bar-cache' : ''}`}
                    style={{ width: `${Math.max(2, (e.bytes / max) * 100)}%` }}
                  />
                </span>
                <span className="disk-size">{formatBytes(e.bytes)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

/** The "Data" sub-section: analyse Mira's disk footprint, and wipe the current
 * profile's browsing data (cookies, cache, storage). The wipe is destructive, so
 * it uses a two-step confirm. */
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
      <DiskUsage />
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

interface TabProcess {
  pid: number
  bytes: number
  label: string
  main: boolean
  shared: number
}

interface TabMemoryEntry {
  tabId: string
  profileId: string
  profileLabel: string
  title: string
  url: string
  favicon: string | null
  pid: number
  processes: TabProcess[]
  processMemoryBytes: number
  active: boolean
  keepAwake: boolean
}

/** Client-side byte formatter (main has its own; the command returns raw bytes so
 * the table can format for display). "142.5 MB", "1.83 GB" past a gigabyte. */
function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`
  return `${mb.toFixed(1)} MB`
}

/** Host of a url for a compact secondary line (bare host, no scheme/path), or the
 * raw string when it is not a parseable http(s) url (e.g. a blank/home tab). */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** The "Tabs" sub-section: a cross-profile analysis of every loaded tab, ranked by
 * the memory of its renderer process (heaviest first) so the memory hogs surface
 * at the top. Memory is a live snapshot — a manual Refresh re-reads it (no polling,
 * to keep it cheap). Asleep tabs never appear: they hold no process, hence no RAM.
 * Because Chromium reuses one renderer for several same-site pages, a process can
 * back more than one tab — those rows show a "shared" note and the total counts
 * each process once. */
function TabsMemorySection(): React.JSX.Element {
  const [entries, setEntries] = useState<TabMemoryEntry[]>([])
  const [tabsBytes, setTabsBytes] = useState(0)
  const [otherBytes, setOtherBytes] = useState(0)
  const [totalBytes, setTotalBytes] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    setLoading(true)
    const res = await run('list-tab-memory')
    setLoading(false)
    if (res.ok) {
      setEntries((res.entries as TabMemoryEntry[]) ?? [])
      setTabsBytes(Number(res.tabsBytes ?? 0))
      setOtherBytes(Number(res.otherBytes ?? 0))
      setTotalBytes(Number(res.totalBytes ?? 0))
      setError(null)
    } else {
      setError(String(res.error))
    }
  }

  // Put a tab to sleep (Cmd+S): frees its renderer process, keeps the tab. Reuses
  // the existing discard-tab command (resolves the tab by its global id, any
  // window). The tab then drops out of this list (only loaded tabs appear), so
  // refetch after.
  const sleep = async (tabId: string): Promise<void> => {
    const res = await run('discard-tab', { id: tabId })
    if (!res.ok) {
      setError(String(res.error))
      return
    }
    await load()
  }

  useEffect(() => {
    void load()
    // Opening/closing a profile adds or removes its live views, so re-read the
    // snapshot on every profile change — otherwise a closed profile's tabs stay
    // frozen on screen until a manual Refresh.
    return window.mira.onProfilesChanged(load)
  }, [])

  return (
    <div className="settings-section">
      <p className="settings-hint">
        Every loaded tab across all open profiles, ranked by total memory (heaviest first). A tab is
        not one process: under site-per-process its main frame plus every cross-origin subframe
        (embeds, OAuth iframes) each get their own renderer, listed under the row. Sleeping tabs are
        not shown — they hold no process. Everything that backs no tab (extensions, service workers,
        GPU, the app itself) is folded into the “other processes” total so the grand total matches
        the status bar.
      </p>
      <div className="settings-section-head">
        <button className="btn btn-ghost" onClick={() => void load()} disabled={loading}>
          {loading ? 'Reading…' : 'Refresh'}
        </button>
        <span className="settings-hint tab-mem-total">
          {entries.length} loaded {entries.length === 1 ? 'tab' : 'tabs'} ·{' '}
          {formatBytes(tabsBytes)} + {formatBytes(otherBytes)} other ={' '}
          <strong>{formatBytes(totalBytes)}</strong>
        </span>
      </div>
      {error && <p className="settings-error">{error}</p>}
      {entries.length === 0 ? (
        <p className="settings-hint">No loaded tabs.</p>
      ) : (
        <table className="tab-mem-table">
          <thead>
            <tr>
              <th className="tab-mem-rank">#</th>
              <th>Tab</th>
              <th>Profile</th>
              <th className="tab-mem-size">Memory</th>
              <th className="tab-mem-actions" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={e.tabId}>
                <td className="tab-mem-rank">{i + 1}</td>
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
                    {e.active && <span className="tab-mem-badge tab-mem-active">active</span>}
                  </div>
                  <span className="tab-mem-host">{hostOf(e.url)}</span>
                  {e.processes.length > 1 && (
                    <ul className="tab-mem-procs">
                      {e.processes.map((p) => (
                        <li key={p.pid} className="tab-mem-proc">
                          <span className="tab-mem-proc-label">
                            {p.main ? '▸ main frame' : `↳ ${p.label}`}
                            {p.shared > 1 && (
                              <span
                                className="tab-mem-shared"
                                title={`Shared by ${p.shared} tabs`}
                              >
                                shared ×{p.shared}
                              </span>
                            )}
                          </span>
                          <span className="tab-mem-proc-size">{formatBytes(p.bytes)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="tab-mem-profile">{e.profileLabel}</td>
                <td className="tab-mem-size">
                  <strong>{formatBytes(e.processMemoryBytes)}</strong>
                  {e.processes.length > 1 && (
                    <span className="tab-mem-proc-count">{e.processes.length} processes</span>
                  )}
                </td>
                <td className="tab-mem-actions">
                  <button
                    className="btn btn-ghost"
                    onClick={() => void sleep(e.tabId)}
                    disabled={e.keepAwake}
                    title={
                      e.keepAwake
                        ? "Keep-awake tab can't sleep"
                        : 'Put this tab to sleep (Cmd+S): frees its memory, keeps the tab'
                    }
                  >
                    Sleep
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="tab-mem-foot">
              <td />
              <td className="tab-mem-tab">Other processes (extensions, workers, GPU, app)</td>
              <td className="tab-mem-profile" />
              <td className="tab-mem-size">{formatBytes(otherBytes)}</td>
              <td className="tab-mem-actions" />
            </tr>
            <tr className="tab-mem-foot tab-mem-foot-total">
              <td />
              <td className="tab-mem-tab">Total (app-wide)</td>
              <td className="tab-mem-profile" />
              <td className="tab-mem-size">
                <strong>{formatBytes(totalBytes)}</strong>
              </td>
              <td className="tab-mem-actions" />
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  )
}

const SECTIONS: Array<{ key: Section; label: string }> = [
  { key: 'general', label: 'General' },
  { key: 'ai', label: 'AI' },
  { key: 'profiles', label: 'Profiles' },
  { key: 'tabs', label: 'Tabs' },
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
      {section === 'tabs' && <TabsMemorySection />}
      {section === 'extensions' && <ExtensionsSection />}
      {section === 'permissions' && <PermissionsSection />}
      {section === 'data' && <DataSection />}
    </div>
  )
}

export default Settings
