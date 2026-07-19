import { describe, expect, it } from 'vitest'
import {
  deviceDisplayName,
  parsePickResult,
  renderDevicePickerHtml,
  type MediaDevice,
  type MediaPickRequest
} from './media-device-picker'

const cam = (id: string, label = ''): MediaDevice => ({ deviceId: id, label, kind: 'videoinput' })
const mic = (id: string, label = ''): MediaDevice => ({ deviceId: id, label, kind: 'audioinput' })

const req = (over: Partial<MediaPickRequest> = {}): MediaPickRequest => ({
  origin: 'https://example.com',
  wantVideo: true,
  wantAudio: true,
  videoDevices: [cam('cam1', 'FaceTime HD')],
  audioDevices: [mic('mic1', 'Built-in Mic')],
  ...over
})

describe('parsePickResult', () => {
  it('parses a real choice', () => {
    expect(parsePickResult('{"video":"cam1","audio":"mic1"}')).toEqual({
      video: 'cam1',
      audio: 'mic1'
    })
  })

  it('keeps a single-kind choice', () => {
    expect(parsePickResult('{"video":"cam1","audio":null}')).toEqual({ video: 'cam1', audio: null })
  })

  it('is a cancel for empty, unparseable, or all-null', () => {
    expect(parsePickResult('')).toBeNull()
    expect(parsePickResult('not json')).toBeNull()
    expect(parsePickResult('{"video":null,"audio":null}')).toBeNull()
    expect(parsePickResult(undefined)).toBeNull()
  })
})

describe('deviceDisplayName', () => {
  it('uses the OS label when present', () => {
    expect(deviceDisplayName(cam('x', 'FaceTime HD'), 0)).toBe('FaceTime HD')
  })

  it('falls back to a numbered name per kind when the label is empty', () => {
    expect(deviceDisplayName(cam('x'), 0)).toBe('Camera 1')
    expect(deviceDisplayName(mic('y'), 1)).toBe('Microphone 2')
  })
})

describe('renderDevicePickerHtml', () => {
  it('lists devices for both wanted kinds with the first pre-checked', () => {
    const html = renderDevicePickerHtml(
      req({
        videoDevices: [cam('cam1', 'FaceTime HD'), cam('cam2', 'External Cam')],
        audioDevices: [mic('mic1', 'Built-in Mic')]
      })
    )
    expect(html).toContain('FaceTime HD')
    expect(html).toContain('External Cam')
    expect(html).toContain('Built-in Mic')
    expect(html).toContain('value="cam1" checked')
    // second device not pre-checked
    expect(html).toContain('value="cam2" />')
  })

  it('omits a column the page did not request', () => {
    const html = renderDevicePickerHtml(req({ wantAudio: false }))
    expect(html).toContain('FaceTime HD')
    expect(html).not.toContain('Built-in Mic')
    expect(html).not.toContain('name="audio"')
  })

  it('shows the requesting origin', () => {
    expect(renderDevicePickerHtml(req({ origin: 'https://lucy.decart.ai' }))).toContain(
      'https://lucy.decart.ai'
    )
  })

  it('escapes device labels and origin', () => {
    const html = renderDevicePickerHtml(
      req({
        origin: 'https://x.test/<b>',
        videoDevices: [cam('cam1', '<script>evil</script>')],
        wantAudio: false
      })
    )
    expect(html).toContain('&lt;script&gt;evil&lt;/script&gt;')
    expect(html).not.toContain('<script>evil</script>')
    expect(html).toContain('https://x.test/&lt;b&gt;')
  })

  it('disables Allow and explains when no device is available', () => {
    const html = renderDevicePickerHtml(req({ videoDevices: [], audioDevices: [] }))
    expect(html).toContain('No camera or microphone is available')
    expect(html).toContain('disabled')
  })
})
