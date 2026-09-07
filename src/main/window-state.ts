// Window geometry transitions, with an injectable native surface so races can
// be tested without launching Electron.

type WindowStateEvent =
  'enter-full-screen' | 'leave-full-screen' | 'maximize' | 'unmaximize' | 'closed'

export interface WindowStateTarget {
  isDestroyed(): boolean
  isFullScreen(): boolean
  setFullScreen(value: boolean): void
  isMaximized(): boolean
  maximize(): void
  unmaximize(): void
  on(event: WindowStateEvent, listener: () => void): unknown
  off(event: WindowStateEvent, listener: () => void): unknown
}

function requireLiveWindow(window: WindowStateTarget): void {
  if (window.isDestroyed()) throw new Error('window was closed')
}

/** Listen before invoking the native operation, including for synchronous
 * events. Closing cancels the wait; every completion path removes listeners. */
function transition(
  window: WindowStateTarget,
  event: WindowStateEvent,
  apply: () => void,
  timeoutMs: number
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    requireLiveWindow(window)
    const cleanup = (): void => {
      clearTimeout(timer)
      window.off(event, done)
      window.off('closed', closed)
    }
    const done = (): void => {
      cleanup()
      resolve()
    }
    const closed = (): void => {
      cleanup()
      reject(new Error('window was closed'))
    }
    const timer = setTimeout(done, timeoutMs)
    window.on(event, done)
    window.on('closed', closed)
    try {
      apply()
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
}

// A second toggle reverses the last request, not the stale native flag while
// macOS is animating. Tokens keep an earlier completion from clearing a later
// request. Weak keys do not retain closed windows.
const fullScreenRequests = new WeakMap<WindowStateTarget, { value: boolean }>()

export async function changeWindowFullScreen(
  window: WindowStateTarget,
  value: boolean | undefined,
  persist: () => void
): Promise<boolean> {
  requireLiveWindow(window)
  const request = {
    value: value ?? !(fullScreenRequests.get(window)?.value ?? window.isFullScreen())
  }
  fullScreenRequests.set(window, request)
  try {
    // Always forward the request: a page or another command may have started a
    // transition that isFullScreen() does not yet reflect. Electron queues the
    // requested state behind that transition. A real no-op emits no event, so
    // the bounded wait also covers that case.
    await transition(
      window,
      request.value ? 'enter-full-screen' : 'leave-full-screen',
      () => window.setFullScreen(request.value),
      3000
    )
    // The window can close after the event, before this continuation runs.
    requireLiveWindow(window)
    const fullScreen = window.isFullScreen()
    persist()
    return fullScreen
  } finally {
    if (fullScreenRequests.get(window) === request) fullScreenRequests.delete(window)
  }
}

export async function changeWindowMaximized(
  window: WindowStateTarget,
  value: boolean | undefined,
  persist: () => void
): Promise<boolean> {
  requireLiveWindow(window)
  const current = window.isMaximized()
  const next = value ?? !current
  if (window.isFullScreen() || next === current) return current
  // Some macOS windows already occupy the work area without having a zoom
  // restore rectangle. unmaximize() then emits nothing; report the actual state
  // after the timeout rather than claiming the requested change took place.
  await transition(
    window,
    next ? 'maximize' : 'unmaximize',
    () => (next ? window.maximize() : window.unmaximize()),
    1000
  )
  requireLiveWindow(window)
  const maximized = window.isMaximized()
  persist()
  return maximized
}
