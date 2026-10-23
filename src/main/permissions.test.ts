import { describe, it, expect } from 'vitest'
import { shouldGrantPermission } from './permissions'

describe('shouldGrantPermission', () => {
  it('grants ordinary permissions (geolocation, media, notifications, …)', () => {
    for (const p of ['geolocation', 'notifications', 'media', 'midiSysex', 'usb', 'unknown']) {
      expect(shouldGrantPermission(p)).toBe(true)
    }
  })

  it('denies clipboard-read (check and request alike)', () => {
    expect(shouldGrantPermission('clipboard-read')).toBe(false)
    expect(shouldGrantPermission('clipboard-read', {})).toBe(false)
    expect(shouldGrantPermission('deprecated-sync-clipboard-read')).toBe(false)
  })

  it('keeps clipboard writing allowed', () => {
    expect(shouldGrantPermission('clipboard-sanitized-write')).toBe(true)
  })

  it('grants openExternal for an allowlisted scheme', () => {
    expect(shouldGrantPermission('openExternal', { externalURL: 'mailto:x@y.z' })).toBe(true)
    for (const url of [
      'tel:+33100000000',
      'sms:+33100000000',
      'facetime:a@b.c',
      'facetime-audio:a@b.c',
      'zoommtg://zoom.us/join?confno=1',
      'zoomus://zoom.us/join',
      'slack://open',
      'msteams:/l/meetup-join/x',
      'MAILTO:x@y.z'
    ]) {
      expect(shouldGrantPermission('openExternal', { externalURL: url })).toBe(true)
    }
  })

  it('denies openExternal for any other scheme', () => {
    expect(shouldGrantPermission('openExternal', { externalURL: 'x-evil://a' })).toBe(false)
    expect(shouldGrantPermission('openExternal', { externalURL: 'file:///etc/passwd' })).toBe(false)
  })

  it('denies openExternal without a usable URL', () => {
    expect(shouldGrantPermission('openExternal')).toBe(false)
    expect(shouldGrantPermission('openExternal', {})).toBe(false)
    expect(shouldGrantPermission('openExternal', { externalURL: '' })).toBe(false)
    expect(shouldGrantPermission('openExternal', { externalURL: 'not a url' })).toBe(false)
  })
})
