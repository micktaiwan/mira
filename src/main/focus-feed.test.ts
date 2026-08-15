import { describe, it, expect } from 'vitest'
import { FocusFeed, sameFocus, type TabFocus } from './focus-feed'

const focus = (over: Partial<TabFocus> = {}): TabFocus => ({
  windowId: 'w1',
  profileId: 'default',
  profileLabel: 'pro: lempire',
  tabId: 't1',
  url: 'https://app.trykondo.com/',
  title: 'Kondo',
  folderId: null,
  folderTitle: null,
  ...over
})

describe('sameFocus', () => {
  it('matches identical snapshots', () => {
    expect(sameFocus(focus(), focus())).toBe(true)
  })

  it('separates null from a tab', () => {
    expect(sameFocus(null, focus())).toBe(false)
    expect(sameFocus(null, null)).toBe(true)
  })

  it('sees a navigation inside the same tab', () => {
    expect(sameFocus(focus(), focus({ url: 'https://app.trykondo.com/settings' }))).toBe(false)
  })

  it('sees a tab moved into a folder', () => {
    expect(sameFocus(focus(), focus({ folderId: 'f1', folderTitle: 'Prod' }))).toBe(false)
  })
})

describe('FocusFeed', () => {
  it('starts with no focus', () => {
    expect(new FocusFeed().current).toBeNull()
  })

  it('delivers changes to every subscriber and remembers the last one', () => {
    const feed = new FocusFeed()
    const a: (TabFocus | null)[] = []
    const b: (TabFocus | null)[] = []
    feed.subscribe((f) => a.push(f))
    feed.subscribe((f) => b.push(f))

    feed.publish(focus())
    feed.publish(null)

    expect(a).toEqual([focus(), null])
    expect(b).toEqual(a)
    expect(feed.current).toBeNull()
  })

  it('swallows a re-publish of the same snapshot', () => {
    const feed = new FocusFeed()
    const seen: (TabFocus | null)[] = []
    feed.subscribe((f) => seen.push(f))

    feed.publish(focus())
    feed.publish(focus())
    feed.publish(focus({ title: 'Kondo — settings' }))

    expect(seen).toHaveLength(2)
  })

  it('stops delivering after unsubscribe', () => {
    const feed = new FocusFeed()
    const seen: (TabFocus | null)[] = []
    const off = feed.subscribe((f) => seen.push(f))
    feed.publish(focus())
    off()
    feed.publish(null)
    expect(seen).toEqual([focus()])
    expect(feed.subscriberCount).toBe(0)
  })

  it('keeps serving the others when one listener throws', () => {
    const feed = new FocusFeed()
    const seen: (TabFocus | null)[] = []
    feed.subscribe(() => {
      throw new Error('socket closed')
    })
    feed.subscribe((f) => seen.push(f))
    expect(() => feed.publish(focus())).not.toThrow()
    expect(seen).toEqual([focus()])
  })
})
