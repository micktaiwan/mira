// The native macOS "About Mira" panel (shown by the app-menu `role: 'about'`).
// Left to its defaults it reads the package.json scaffold junk ("example.com",
// a doubled "1.0.0 (1.0.0)"). We override it via app.setAboutPanelOptions so the
// panel says something true about Mira. The string-building is a pure function
// here (testable, per the "tout testable" principle); index.ts only wires the
// runtime values (version, year, Chromium build) and hands it to Electron.

import type { AboutPanelOptionsOptions } from 'electron'

export interface AboutInput {
  /** App version, e.g. app.getVersion() → "1.0.0". */
  version: string
  /** Copyright year (a number), e.g. new Date().getFullYear(). */
  year: number
  /** Chromium version behind the app, e.g. process.versions.chrome. Shown as the
   * build "(Chromium NNN)" in place of the meaningless doubled version. */
  chrome?: string
}

/** Build the options for the native About panel. Pure: same input → same output. */
export function aboutPanelOptions({ version, year, chrome }: AboutInput): AboutPanelOptionsOptions {
  return {
    applicationName: 'Mira',
    applicationVersion: version,
    // The parenthesised "build" slot: surface the real Chromium version instead
    // of a copy of applicationVersion. Omitted when unknown so no empty "()".
    ...(chrome ? { version: `Chromium ${chrome}` } : {}),
    copyright: `© ${year} Mickael Faivre-Maçon`,
    // Shown under the version. "mira" = look (Latin mirari, to marvel) + a star:
    // a browser's job is to show the web.
    credits: 'A personal web browser, built on Chromium.\nmira — “look”, from Latin mirari (to marvel), and a star.'
  }
}
