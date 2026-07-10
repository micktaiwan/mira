import { describe, it, expect } from 'vitest'
import { decideLocationAction, locationSettingsUrl } from './geolocation'

describe('decideLocationAction', () => {
  it('prompts (native) when the OS status is not-determined', () => {
    expect(decideLocationAction('geolocation', 'darwin', 'not-determined', false)).toBe('prompt')
  })

  it('opens Settings once when the OS status is denied', () => {
    expect(decideLocationAction('geolocation', 'darwin', 'denied', false)).toBe('open-settings')
    // ...but not again once already opened this run
    expect(decideLocationAction('geolocation', 'darwin', 'denied', true)).toBe('noop')
  })

  it('opens Settings when restricted', () => {
    expect(decideLocationAction('geolocation', 'darwin', 'restricted', false)).toBe('open-settings')
  })

  it('does NOTHING when already authorized — the hard requirement', () => {
    // Even on the very first request of the run, a working setup must not be nagged.
    expect(decideLocationAction('geolocation', 'darwin', 'authorized', false)).toBe('noop')
  })

  it('does nothing when the status is unavailable (no addon / cannot tell)', () => {
    expect(decideLocationAction('geolocation', 'darwin', 'unavailable', false)).toBe('noop')
  })

  it('does nothing for a non-geolocation permission', () => {
    expect(decideLocationAction('notifications', 'darwin', 'not-determined', false)).toBe('noop')
    expect(decideLocationAction('media', 'darwin', 'denied', false)).toBe('noop')
  })

  it('does nothing off macOS, where no OS tick gates a granted permission', () => {
    expect(decideLocationAction('geolocation', 'win32', 'not-determined', false)).toBe('noop')
    expect(decideLocationAction('geolocation', 'linux', 'denied', false)).toBe('noop')
  })
})

describe('locationSettingsUrl', () => {
  it('deep-links to the Location Services pane on macOS', () => {
    expect(locationSettingsUrl('darwin')).toBe(
      'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_LocationServices'
    )
  })

  it('has nothing to open off macOS', () => {
    expect(locationSettingsUrl('win32')).toBeNull()
    expect(locationSettingsUrl('linux')).toBeNull()
  })
})
