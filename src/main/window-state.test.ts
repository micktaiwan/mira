import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { changeWindowFullScreen, changeWindowMaximized } from './window-state'

class TestWindow extends EventEmitter {
  destroyed = false
  fullScreen = false
  maximized = false
  setFullScreen = vi.fn<(value: boolean) => void>()
  maximize = vi.fn()
  unmaximize = vi.fn()

  isDestroyed(): boolean {
    return this.destroyed
  }

  isFullScreen(): boolean {
    if (this.destroyed) throw new Error('Object has been destroyed')
    return this.fullScreen
  }

  isMaximized(): boolean {
    if (this.destroyed) throw new Error('Object has been destroyed')
    return this.maximized
  }

  settleFullScreen(value: boolean): void {
    this.fullScreen = value
    this.emit(value ? 'enter-full-screen' : 'leave-full-screen')
  }

  close(): void {
    this.destroyed = true
    this.emit('closed')
  }
}

function expectClean(window: TestWindow): void {
  expect(window.eventNames()).toEqual([])
  expect(vi.getTimerCount()).toBe(0)
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('fullscreen transitions', () => {
  it('queues an exit behind an entering command even while the native flag is false', async () => {
    const window = new TestWindow()
    const persist = vi.fn()
    const entering = changeWindowFullScreen(window, true, persist)
    const leaving = changeWindowFullScreen(window, false, persist)
    expect(window.setFullScreen.mock.calls).toEqual([[true], [false]])
    expect(persist).not.toHaveBeenCalled()

    window.settleFullScreen(true)
    await expect(entering).resolves.toBe(true)
    expect(window.listenerCount('leave-full-screen')).toBe(1)
    window.settleFullScreen(false)
    await expect(leaving).resolves.toBe(false)
    expect(persist).toHaveBeenCalledTimes(2)
    expectClean(window)
  })

  it('cancels a page-initiated enter that has not updated the native flag yet', async () => {
    const window = new TestWindow()
    // Chromium, outside this module, already requested native fullscreen.
    window.setFullScreen(true)
    const saved: boolean[] = []
    const leaving = changeWindowFullScreen(window, false, () => saved.push(window.fullScreen))
    expect(window.setFullScreen).toHaveBeenLastCalledWith(false)
    window.settleFullScreen(true)
    await Promise.resolve()
    expect(saved).toEqual([])
    window.settleFullScreen(false)
    await expect(leaving).resolves.toBe(false)
    expect(saved).toEqual([false])
    expectClean(window)
  })

  it('toggles the pending requested state and does not clear a later request prematurely', async () => {
    const window = new TestWindow()
    const persist = vi.fn()
    const entering = changeWindowFullScreen(window, undefined, persist)
    const leaving = changeWindowFullScreen(window, undefined, persist)
    window.settleFullScreen(true)
    await entering
    const reentering = changeWindowFullScreen(window, undefined, persist)
    expect(window.setFullScreen.mock.calls).toEqual([[true], [false], [true]])
    window.settleFullScreen(false)
    await leaving
    window.settleFullScreen(true)
    await reentering
    expectClean(window)
  })

  it('bounds the wait for a native no-op and returns its actual state', async () => {
    const window = new TestWindow()
    const persist = vi.fn()
    const result = changeWindowFullScreen(window, false, persist)
    await vi.advanceTimersByTimeAsync(3000)
    await expect(result).resolves.toBe(false)
    expect(persist).toHaveBeenCalledOnce()
    expectClean(window)
  })

  it('listens before applying a synchronous native transition', async () => {
    const window = new TestWindow()
    window.setFullScreen.mockImplementation((value) => window.settleFullScreen(value))
    await expect(changeWindowFullScreen(window, true, vi.fn())).resolves.toBe(true)
    expectClean(window)
  })

  it('cleans up after a native exception', async () => {
    const window = new TestWindow()
    const persist = vi.fn()
    window.setFullScreen.mockImplementation(() => {
      throw new Error('native failure')
    })
    await expect(changeWindowFullScreen(window, true, persist)).rejects.toThrow('native failure')
    expect(persist).not.toHaveBeenCalled()
    expectClean(window)
  })
})

describe.each([
  ['fullscreen', changeWindowFullScreen, 'enter-full-screen'],
  ['maximize', changeWindowMaximized, 'maximize']
] as const)('%s window lifetime', (_name, change, event) => {
  it('cancels on close without restoring open:true in the saved session', async () => {
    const window = new TestWindow()
    const session = { open: true }
    const persist = vi.fn(() => {
      session.open = true
    })
    const result = change(window, true, persist)
    const rejected = expect(result).rejects.toThrow('window was closed')
    window.close()
    session.open = false
    await rejected
    await vi.runAllTimersAsync()
    expect(session.open).toBe(false)
    expect(persist).not.toHaveBeenCalled()
    expectClean(window)
  })

  it('checks lifetime again if the window closes immediately after the transition event', async () => {
    const window = new TestWindow()
    const persist = vi.fn()
    const result = change(window, true, persist)
    window.emit(event)
    window.close()
    await expect(result).rejects.toThrow('window was closed')
    expect(persist).not.toHaveBeenCalled()
    expectClean(window)
  })

  it('rejects an already destroyed window without registering listeners', async () => {
    const window = new TestWindow()
    window.close()
    const persist = vi.fn()
    await expect(change(window, true, persist)).rejects.toThrow('window was closed')
    expect(persist).not.toHaveBeenCalled()
    expectClean(window)
  })
})

describe('maximize transitions', () => {
  it('saves the state after the native transition', async () => {
    const window = new TestWindow()
    const saved: boolean[] = []
    const result = changeWindowMaximized(window, true, () => saved.push(window.maximized))
    expect(saved).toEqual([])
    window.maximized = true
    window.emit('maximize')
    await expect(result).resolves.toBe(true)
    expect(saved).toEqual([true])
    expectClean(window)
  })

  it('leaves a fullscreen window alone', async () => {
    const window = new TestWindow()
    window.fullScreen = true
    await expect(changeWindowMaximized(window, true, vi.fn())).resolves.toBe(false)
    expect(window.maximize).not.toHaveBeenCalled()
    expectClean(window)
  })

  it('reports the actual state when macOS cannot restore a work-area-sized window', async () => {
    const window = new TestWindow()
    window.maximized = true
    const persist = vi.fn()
    const result = changeWindowMaximized(window, false, persist)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(result).resolves.toBe(true)
    expect(window.unmaximize).toHaveBeenCalledOnce()
    expect(persist).toHaveBeenCalledOnce()
    expectClean(window)
  })
})
