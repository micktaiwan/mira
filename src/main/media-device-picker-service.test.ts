import { describe, expect, it } from 'vitest'
import { normalizePickRequest } from './media-device-picker-service'

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
    expect(req.videoDevices).toEqual([{ deviceId: 'cam1', label: 'FaceTime HD', kind: 'videoinput' }])
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
