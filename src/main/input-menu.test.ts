import { describe, expect, it } from 'vitest'
import { withMenuShortcutsIgnored } from './input-menu'

// The flag is per-webContents and sticky, so the failure that matters is a
// dispatch that throws (the dropped-input guard does) and leaves it ON: every
// later REAL Cmd+<key> in that tab would stop working, with no error anywhere.

describe('withMenuShortcutsIgnored', () => {
  it('wraps the dispatch: ignored for it, restored after it', async () => {
    const order: string[] = []
    const wc = {
      setIgnoreMenuShortcuts: (ignore: boolean) => order.push(ignore ? 'ignore' : 'listen')
    }
    await withMenuShortcutsIgnored(wc, async () => {
      order.push('dispatch')
    })
    expect(order).toEqual(['ignore', 'dispatch', 'listen'])
  })

  it('restores menu shortcuts when the dispatch throws', async () => {
    const calls: boolean[] = []
    const wc = { setIgnoreMenuShortcuts: (ignore: boolean) => calls.push(ignore) }
    await expect(
      withMenuShortcutsIgnored(wc, async () => {
        throw new Error('input was dropped')
      })
    ).rejects.toThrow('input was dropped')
    expect(calls).toEqual([true, false])
  })
})
