// App-wide settings, pure and Electron-free (the testable half). index.ts reads /
// writes it as userData/settings.json; the ProfileManager holds the live copy and
// uses homeUrl for new tabs and fresh profile windows. Only one setting today (the
// home page URL), but the shape + normalizer live here so adding a setting stays a
// pure, tested change — mirrors profile-store.ts / session-store.ts.

/** Every user-facing app setting. */
export interface AppSettings {
  /** URL a new tab (and a fresh profile window with no saved tabs) opens on. */
  homeUrl: string
}

/** The built-in home page, used when nothing is persisted yet. */
export const DEFAULT_HOME_URL = 'https://www.example.com'

export function defaultSettings(): AppSettings {
  return { homeUrl: DEFAULT_HOME_URL }
}

/** Defensively parse the persisted settings file: keep a non-empty string homeUrl,
 * else fall back to the default. A bad/missing file degrades to defaults rather
 * than throwing. */
export function normalizeSettings(raw: unknown): AppSettings {
  if (!raw || typeof raw !== 'object') return defaultSettings()
  const v = raw as Record<string, unknown>
  const homeUrl =
    typeof v.homeUrl === 'string' && v.homeUrl.trim() !== '' ? v.homeUrl.trim() : DEFAULT_HOME_URL
  return { homeUrl }
}

/** Return settings with a new home URL. Trims; an empty value is rejected (returns
 * the settings unchanged) so the home page can never be cleared to nothing. */
export function withHomeUrl(settings: AppSettings, url: string): AppSettings {
  const trimmed = url.trim()
  if (trimmed === '') return settings
  return { ...settings, homeUrl: trimmed }
}
