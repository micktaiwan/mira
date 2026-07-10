import { describe, it, expect } from 'vitest'
import { aboutPanelOptions } from './about'

describe('aboutPanelOptions', () => {
  it('names Mira and drops the package.json scaffold defaults', () => {
    const o = aboutPanelOptions({ version: '1.0.0', year: 2026, chrome: '141.0.0.0' })
    expect(o.applicationName).toBe('Mira')
    expect(o.applicationVersion).toBe('1.0.0')
    expect(o.copyright).toBe('© 2026 Mickael Faivre-Maçon')
    // no trace of the scaffold "example.com" copyright
    expect(JSON.stringify(o)).not.toContain('example.com')
  })

  it('surfaces the Chromium build instead of a doubled version', () => {
    const o = aboutPanelOptions({ version: '1.0.0', year: 2026, chrome: '141.0.0.0' })
    expect(o.version).toBe('Chromium 141.0.0.0')
  })

  it('omits the build slot when the Chromium version is unknown', () => {
    const o = aboutPanelOptions({ version: '1.0.0', year: 2026 })
    expect(o.version).toBeUndefined()
  })

  it('threads the year through the copyright', () => {
    expect(aboutPanelOptions({ version: '2.1', year: 2030 }).copyright).toBe(
      '© 2030 Mickael Faivre-Maçon'
    )
  })
})
