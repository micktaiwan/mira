import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ProfileData, type ProfileDataDeps } from './profile-data'

const DEBOUNCE = 500

function make(over?: Partial<ProfileDataDeps>): {
  data: ProfileData
  persistHistory: ReturnType<typeof vi.fn>
  persistPermissions: ReturnType<typeof vi.fn>
  onPermissionsChanged: ReturnType<typeof vi.fn>
} {
  const persistHistory = vi.fn()
  const persistPermissions = vi.fn()
  const onPermissionsChanged = vi.fn()
  let clock = 1_000
  const data = new ProfileData({
    initialHistory: [],
    persistHistory,
    initialPermissions: [],
    persistPermissions,
    onPermissionsChanged,
    debounceMs: DEBOUNCE,
    now: () => clock++,
    ...over
  })
  return { data, persistHistory, persistPermissions, onPermissionsChanged }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('ProfileData history', () => {
  it('skips non-web urls (about:, mira://, file://) — no record, no flush', () => {
    const { data, persistHistory } = make()
    data.recordVisit('about:blank', 'Blank')
    data.recordVisit('mira://settings', 'Settings')
    data.recordVisit('file:///tmp/x', 'Local')
    vi.advanceTimersByTime(DEBOUNCE)
    expect(data.listHistory(100)).toHaveLength(0)
    expect(persistHistory).not.toHaveBeenCalled()
  })

  it('records a web visit and flushes once, debounced', () => {
    const { data, persistHistory } = make()
    data.recordVisit('https://a.com', 'A')
    // Nothing written yet — the flush is debounced.
    expect(persistHistory).not.toHaveBeenCalled()
    vi.advanceTimersByTime(DEBOUNCE)
    expect(persistHistory).toHaveBeenCalledTimes(1)
    expect(data.listHistory(100)).toHaveLength(1)
  })

  it('dedups by url (a re-visit bumps, does not duplicate)', () => {
    const { data } = make()
    data.recordVisit('https://a.com', 'A')
    data.recordVisit('https://a.com', 'A again')
    expect(data.listHistory(100)).toHaveLength(1)
  })

  it('searchHistory matches url/title substrings', () => {
    const { data } = make()
    data.recordVisit('https://alpha.com', 'Alpha')
    data.recordVisit('https://beta.com', 'Beta')
    expect(data.searchHistory('alpha').map((e) => e.url)).toEqual(['https://alpha.com'])
  })

  it('clearHistory empties the list and persists immediately (cancels the pending flush)', () => {
    const { data, persistHistory } = make()
    data.recordVisit('https://a.com', 'A')
    const { cleared } = data.clearHistory()
    expect(cleared).toBe(1)
    expect(data.listHistory(100)).toHaveLength(0)
    expect(persistHistory).toHaveBeenCalledTimes(1)
    // The armed debounce must have been cancelled — no second write lands later.
    vi.advanceTimersByTime(DEBOUNCE)
    expect(persistHistory).toHaveBeenCalledTimes(1)
  })
})

describe('ProfileData permissions', () => {
  it('skips empty / opaque origins', () => {
    const { data, persistPermissions, onPermissionsChanged } = make()
    data.recordGrant('', 'geolocation')
    data.recordGrant('null', 'geolocation')
    vi.advanceTimersByTime(DEBOUNCE)
    expect(data.listPermissions()).toHaveLength(0)
    expect(persistPermissions).not.toHaveBeenCalled()
    expect(onPermissionsChanged).not.toHaveBeenCalled()
  })

  it('records a grant, broadcasts immediately, and flushes debounced', () => {
    const { data, persistPermissions, onPermissionsChanged } = make()
    data.recordGrant('https://maps.google.com', 'geolocation')
    expect(onPermissionsChanged).toHaveBeenCalledTimes(1)
    expect(persistPermissions).not.toHaveBeenCalled()
    vi.advanceTimersByTime(DEBOUNCE)
    expect(persistPermissions).toHaveBeenCalledTimes(1)
    expect(data.listPermissions()).toHaveLength(1)
  })

  it('clearPermissions empties, persists now, and broadcasts', () => {
    const { data, persistPermissions, onPermissionsChanged } = make()
    data.recordGrant('https://maps.google.com', 'geolocation')
    onPermissionsChanged.mockClear()
    const { cleared } = data.clearPermissions()
    expect(cleared).toBe(1)
    expect(data.listPermissions()).toHaveLength(0)
    expect(persistPermissions).toHaveBeenCalledTimes(1)
    expect(onPermissionsChanged).toHaveBeenCalledTimes(1)
  })
})

describe('ProfileData.flush', () => {
  it('writes both lists now and cancels pending debounces', () => {
    const { data, persistHistory, persistPermissions } = make()
    data.recordVisit('https://a.com', 'A')
    data.recordGrant('https://a.com', 'geolocation')
    data.flush()
    expect(persistHistory).toHaveBeenCalledTimes(1)
    expect(persistPermissions).toHaveBeenCalledTimes(1)
    // Debounces were cancelled by flush — no extra writes fire later.
    vi.advanceTimersByTime(DEBOUNCE)
    expect(persistHistory).toHaveBeenCalledTimes(1)
    expect(persistPermissions).toHaveBeenCalledTimes(1)
  })
})
