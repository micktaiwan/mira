import { describe, expect, it } from 'vitest'
import { applyChosenDevices, parseMediaWants } from './media-device-picker-shim'

describe('parseMediaWants', () => {
  it('reads truthy video/audio constraints as wanted', () => {
    expect(parseMediaWants({ video: true, audio: true })).toEqual({
      wantVideo: true,
      wantAudio: true
    })
  })

  it('treats a constraints OBJECT as wanted, not just true', () => {
    expect(parseMediaWants({ video: { width: 1280 }, audio: false })).toEqual({
      wantVideo: true,
      wantAudio: false
    })
  })

  it('treats missing / false / undefined as not wanted', () => {
    expect(parseMediaWants({ audio: true })).toEqual({ wantVideo: false, wantAudio: true })
    expect(parseMediaWants({ video: false, audio: false })).toEqual({
      wantVideo: false,
      wantAudio: false
    })
    expect(parseMediaWants(undefined)).toEqual({ wantVideo: false, wantAudio: false })
    expect(parseMediaWants(null)).toEqual({ wantVideo: false, wantAudio: false })
  })
})

describe('applyChosenDevices', () => {
  it('pins the chosen camera with an exact deviceId when video was true', () => {
    const next = applyChosenDevices({ video: true, audio: true }, { video: 'cam1', audio: 'mic1' })
    expect(next.video).toEqual({ deviceId: { exact: 'cam1' } })
    expect(next.audio).toEqual({ deviceId: { exact: 'mic1' } })
  })

  it('preserves an existing constraints object and adds the exact deviceId', () => {
    const next = applyChosenDevices(
      { video: { width: 1280, height: 720 } },
      { video: 'cam1', audio: null }
    )
    expect(next.video).toEqual({ width: 1280, height: 720, deviceId: { exact: 'cam1' } })
  })

  it('leaves a kind untouched when it was not wanted', () => {
    const next = applyChosenDevices({ video: true }, { video: 'cam1', audio: 'mic1' })
    expect(next.video).toEqual({ deviceId: { exact: 'cam1' } })
    // audio was not requested — a stray choice must not add an audio constraint.
    expect(next.audio).toBeUndefined()
  })

  it('leaves a wanted kind untouched when the pick had no device for it', () => {
    const next = applyChosenDevices({ video: true, audio: true }, { video: 'cam1', audio: null })
    expect(next.video).toEqual({ deviceId: { exact: 'cam1' } })
    expect(next.audio).toBe(true) // original value kept, so it falls back to default
  })

  it('does not mutate the original constraints', () => {
    const orig = { video: true, audio: true }
    applyChosenDevices(orig, { video: 'cam1', audio: 'mic1' })
    expect(orig).toEqual({ video: true, audio: true })
  })
})
