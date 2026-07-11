// App-wide settings, pure and Electron-free (the testable half). index.ts reads /
// writes it as userData/settings.json; the ProfileManager holds the live copy and
// uses homeUrl for new tabs and fresh profile windows. Only one setting today (the
// home page URL), but the shape + normalizer live here so adding a setting stays a
// pure, tested change — mirrors profile-store.ts / session-store.ts.

import { LLM_PROVIDERS, type LlmConfig, type LlmProvider } from './llm'

/** Every user-facing app setting. */
export interface AppSettings {
  /** URL a new tab (and a fresh profile window with no saved tabs) opens on.
   * Empty string means "open blank" — a new tab shows Mira's home page (the session
   * summary, see home-doc.ts) with its address bar empty, instead of a real site. */
  homeUrl: string
  /** The AI engine skills use to summarize (provider + optional key/model). */
  llm: LlmConfig
  /** Width (px) of the left tab panel — resizable by dragging its edge. */
  sidebarWidth: number
  /** Width (px) of the right skill pane — resizable by dragging its edge. */
  skillPaneWidth: number
}

/** Allowed range + default for each resizable panel width. Main clamps to these
 * (a drag can't shrink a panel to nothing or eat the whole window); the chrome
 * uses the same bounds so its drag matches. Defaults mirror --sidebar-width /
 * --skill-pane-width in the CSS (the pre-JS fallback). */
export const SIDEBAR_WIDTH = { min: 160, max: 480, default: 240 }
export const SKILL_PANE_WIDTH = { min: 260, max: 720, default: 360 }

/** Clamp a width to a range; a non-finite value falls back to the range default. */
export function clampWidth(
  width: unknown,
  range: { min: number; max: number; default: number }
): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) return range.default
  return Math.round(Math.max(range.min, Math.min(range.max, width)))
}

/** The built-in home page, used when nothing is persisted yet. */
export const DEFAULT_HOME_URL = 'https://www.example.com'

/** The default AI engine: Claude Code print mode, which uses the logged-in
 * subscription with no API key. */
export function defaultLlm(): LlmConfig {
  return { provider: 'claude-cli' }
}

/** The bare blank URL. A blank tab (empty homeUrl) actually renders Mira's home
 * page (home-doc.ts); this constant remains the canonical "nothing loaded" value
 * that isMiraHomeUrl also treats as the blank home. Stored tab.url stays '' so the
 * address bar shows nothing. */
export const BLANK_TAB_URL = 'about:blank'

export function defaultSettings(): AppSettings {
  return {
    homeUrl: DEFAULT_HOME_URL,
    llm: defaultLlm(),
    sidebarWidth: SIDEBAR_WIDTH.default,
    skillPaneWidth: SKILL_PANE_WIDTH.default
  }
}

/** Defensively parse a persisted LLM config: an unknown provider or a bad file
 * degrades to the default engine. Key/model are kept only when they are strings. */
export function normalizeLlm(raw: unknown): LlmConfig {
  if (!raw || typeof raw !== 'object') return defaultLlm()
  const v = raw as Record<string, unknown>
  const provider = LLM_PROVIDERS.includes(v.provider as LlmProvider)
    ? (v.provider as LlmProvider)
    : defaultLlm().provider
  const config: LlmConfig = { provider }
  if (typeof v.apiKey === 'string' && v.apiKey.trim() !== '') config.apiKey = v.apiKey.trim()
  if (typeof v.model === 'string' && v.model.trim() !== '') config.model = v.model.trim()
  if (typeof v.loadMcp === 'boolean') config.loadMcp = v.loadMcp
  return config
}

/** Defensively parse the persisted settings file. A string homeUrl is kept as-is
 * (trimmed) — including an explicit empty string, which the user set to make new
 * tabs open blank. Only a missing / non-string homeUrl falls back to the default,
 * so a fresh install still gets a home page. A bad/missing file degrades to
 * defaults rather than throwing. */
export function normalizeSettings(raw: unknown): AppSettings {
  if (!raw || typeof raw !== 'object') return defaultSettings()
  const v = raw as Record<string, unknown>
  const homeUrl = typeof v.homeUrl === 'string' ? v.homeUrl.trim() : DEFAULT_HOME_URL
  return {
    homeUrl,
    llm: normalizeLlm(v.llm),
    sidebarWidth: clampWidth(v.sidebarWidth, SIDEBAR_WIDTH),
    skillPaneWidth: clampWidth(v.skillPaneWidth, SKILL_PANE_WIDTH)
  }
}

/** Return settings with a new home URL. Trims. An empty value is allowed and
 * clears the home page, so new tabs open blank. */
export function withHomeUrl(settings: AppSettings, url: string): AppSettings {
  return { ...settings, homeUrl: url.trim() }
}

/** Return settings with a new (normalized) LLM config. */
export function withLlm(settings: AppSettings, llm: unknown): AppSettings {
  return { ...settings, llm: normalizeLlm(llm) }
}

/** Return settings with a clamped sidebar width. */
export function withSidebarWidth(settings: AppSettings, width: number): AppSettings {
  return { ...settings, sidebarWidth: clampWidth(width, SIDEBAR_WIDTH) }
}

/** Return settings with a clamped skill-pane width. */
export function withSkillPaneWidth(settings: AppSettings, width: number): AppSettings {
  return { ...settings, skillPaneWidth: clampWidth(width, SKILL_PANE_WIDTH) }
}
