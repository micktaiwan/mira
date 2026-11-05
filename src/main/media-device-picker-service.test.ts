import { existsSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { PickerSkipStore, normalizePickRequest } from './media-device-picker-service'

vi.mock('electron', () => ({ BrowserWindow: {}, ipcMain: {} }))

describe('PickerSkipStore', () => {
  const dir = (): string => mkdtempSync(join(tmpdir(), 'mira-skip-'))

  it('skips nothing by default', () => {
    expect(new PickerSkipStore(dir()).isSkipped('site.test')).toBe(false)
  })

  it('persists a learned host in its own folder only', () => {
    const a = dir()
    new PickerSkipStore(a).learn('site.test')
    expect(new PickerSkipStore(a).isSkipped('site.test')).toBe(true)
    expect(new PickerSkipStore(dir()).isSkipped('site.test')).toBe(false)
  })

  it('drops a ruled-out host and remembers it across restarts', () => {
    const a = dir()
    const s = new PickerSkipStore(a)
    s.learn('site.test')
    s.ruleOut('site.test')
    expect(s.isSkipped('site.test')).toBe(false)
    expect(new PickerSkipStore(a).isRuledOut('site.test')).toBe(true)
  })

  it('works without an earlier read, so a closed profile can be wiped', () => {
    const a = dir()
    new PickerSkipStore(a).learn('site.test')
    new PickerSkipStore(a).forgetDomain('site.test')
    expect(new PickerSkipStore(a).list().learned).toEqual([])
  })

  it('a wipe never recreates a missing folder', () => {
    const gone = join(dir(), 'deleted-profile')
    const s = new PickerSkipStore(gone)
    s.forgetDomain('site.test')
    s.clear()
    s.forget('site.test')
    expect(existsSync(gone)).toBe(false)
  })

  it('a store kept in memory cannot write a wiped host back', () => {
    const a = dir()
    const old = new PickerSkipStore(a)
    old.learn('site.test')
    new PickerSkipStore(a).clear()
    old.learn('other.test')
    expect(old.list().learned).toEqual(['other.test'])
  })

  it('forget gives the picker back and lets the host be suspected again', () => {
    const s = new PickerSkipStore(dir())
    s.learn('site.test')
    s.ruleOut('site.test')
    s.forget('site.test')
    expect(s.list()).toEqual({ learned: [], ruledOut: [] })
  })

  it('forgetDomain wipes the subdomains and keeps the others', () => {
    const s = new PickerSkipStore(dir())
    s.learn('a.site.test')
    s.ruleOut('b.site.test')
    s.learn('other.test')
    s.forgetDomain('site.test')
    expect(s.list()).toEqual({ learned: ['other.test'], ruledOut: [] })
  })

  it('clear leaves nothing on disk', () => {
    const a = dir()
    const s = new PickerSkipStore(a)
    s.learn('site.test')
    s.clear()
    expect(new PickerSkipStore(a).list()).toEqual({ learned: [], ruledOut: [] })
  })
})

describe('normalizePickRequest', () => {
  it('keeps well-formed devices and tags their kind', () => {
    const req = normalizePickRequest({
      origin: 'https://example.com',
      wantVideo: true,
      wantAudio: true,
      videoDevices: [{ deviceId: 'cam1', label: 'FaceTime HD', kind: 'videoinput' }],
      audioDevices: [{ deviceId: 'mic1', label: 'Built-in', kind: 'audioinput' }]
    })
    expect(req.origin).toBe('https://example.com')
    expect(req.videoDevices).toEqual([
      { deviceId: 'cam1', label: 'FaceTime HD', kind: 'videoinput' }
    ])
    expect(req.audioDevices).toEqual([{ deviceId: 'mic1', label: 'Built-in', kind: 'audioinput' }])
  })

  it('drops devices with no deviceId and coerces a missing label', () => {
    const req = normalizePickRequest({
      wantVideo: true,
      videoDevices: [{ deviceId: '', label: 'ghost' }, { deviceId: 'cam1' }]
    })
    expect(req.videoDevices).toEqual([{ deviceId: 'cam1', label: '', kind: 'videoinput' }])
  })

  it('forces the kind by column, ignoring a spoofed kind from the payload', () => {
    const req = normalizePickRequest({
      audioDevices: [{ deviceId: 'mic1', label: 'm', kind: 'videoinput' }]
    })
    expect(req.audioDevices[0].kind).toBe('audioinput')
  })

  it('defaults everything for a malformed payload', () => {
    const req = normalizePickRequest(undefined)
    expect(req).toEqual({
      origin: '',
      wantVideo: false,
      wantAudio: false,
      videoDevices: [],
      audioDevices: []
    })
  })

  it('tolerates non-array device fields', () => {
    const req = normalizePickRequest({ videoDevices: 'nope', audioDevices: 42 })
    expect(req.videoDevices).toEqual([])
    expect(req.audioDevices).toEqual([])
  })
})
