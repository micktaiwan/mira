import { describe, it, expect } from 'vitest'
import { shouldGrantPermission } from './permissions'

describe('shouldGrantPermission', () => {
  it('grants every permission (grant-all policy)', () => {
    for (const p of [
      'geolocation',
      'notifications',
      'media',
      'clipboard-read',
      'midiSysex',
      'usb',
      'unknown'
    ]) {
      expect(shouldGrantPermission(p)).toBe(true)
    }
  })
})
