// Recover a page frozen by the camera picker's getUserMedia patch, on any site.
// Some sites' protected scripts stop running under that patch and nothing announces
// it, so the sites are found at runtime, per profile, and named nowhere in this repo.
// For a minute after a navigation,
// this watches whether the page still answers. A page that stops answering while its
// renderer burns CPU gets its host skipped and one reload WITHOUT the patch. If it
// freezes again, the patch was not the cause: the host is released and left alone.
// A reload can lose what the page held, and a tab under `mira freeze --arm` is skipped.
//
// CPU is part of the test because a page sitting on alert() does not answer either,
// and reloading that would throw away what the user is doing. The logic is pure over
// injected dependencies; the Electron glue is wireFreezeWatchdog below.

import { app, type WebContents } from 'electron'
import { cpus } from 'os'
import { isFreezeProbeArmed, type ProbeDebugger } from './freeze-probe'

export const WATCH_WINDOW_MS = 60_000
export const TICK_MS = 5_000
export const PROBE_TIMEOUT_MS = 4_000
// Six ticks: a page blocked this long is unusable, and a short heavy task is spared.
export const MISSES_TO_FREEZE = 6
export const BUSY_CPU_PERCENT = 70

export interface WatchdogDeps {
  /** Resolves true when the page answered a trivial evaluation in time. */
  probe: () => Promise<boolean>
  /** CPU use of the tab's renderer, in percent of one core. */
  cpuPercent: () => number
  /** The page's host, or '' when it is not an http(s) page. */
  host: () => string
  isSkipped: (host: string) => boolean
  isRuledOut: (host: string) => boolean
  learn: (host: string) => void
  /** The patch was not the cause: drop the host and never suspect it again. */
  ruleOut: (host: string) => void
  recover: () => void
  /** Never given a host: Mira's logs must not say where the user went. */
  log: (message: string) => void
  now: () => number
}

export class FreezeWatchdog {
  private deadline = 0
  private misses = 0
  /** The host we reloaded without the patch, while we check the reload helped. */
  private verifying: string | null = null
  private verifyUntil = 0
  private ticking = false

  constructor(private readonly deps: WatchdogDeps) {}

  get active(): boolean {
    // A freeze that began inside the window is followed to its end.
    return this.deps.now() < this.deadline || this.misses > 0
  }

  /** A main-frame navigation, full or in-page: (re)open the watch window. */
  onNavigate(): void {
    this.deadline = this.deps.now() + WATCH_WINDOW_MS
    this.misses = 0
  }

  async tick(): Promise<void> {
    if (this.ticking || !this.active) return
    this.ticking = true
    try {
      const answered = await this.deps.probe()
      if (answered) {
        this.misses = 0
        return
      }
      const cpu = this.deps.cpuPercent()
      // A renderer's first CPU reading can be 0, so the first miss always counts.
      this.misses = this.misses === 0 || cpu >= BUSY_CPU_PERCENT ? this.misses + 1 : 0
      if (this.misses >= MISSES_TO_FREEZE) this.onFrozen()
    } finally {
      this.ticking = false
    }
  }

  private onFrozen(): void {
    this.misses = 0
    this.deadline = 0
    const { deps } = this
    const host = deps.host()
    // Only the same host, soon after our reload, says the patch was not the cause. A
    // freeze later on, or on another site, says nothing about that reload.
    const stillFrozen = this.verifying === host && deps.now() < this.verifyUntil
    this.verifying = null
    if (stillFrozen) {
      // The user may have wiped this host since our reload: don't write it back.
      if (deps.isSkipped(host)) deps.ruleOut(host)
      deps.log('a page froze again without the camera picker patch: not the cause, patch restored')
      return
    }
    if (!host || deps.isSkipped(host) || deps.isRuledOut(host)) {
      deps.log('a page is frozen, the camera picker patch is already off: no reload')
      return
    }
    deps.learn(host)
    this.verifying = host
    this.verifyUntil = deps.now() + WATCH_WINDOW_MS
    this.deadline = this.verifyUntil
    deps.log('a page froze: reloading without the camera picker patch')
    deps.recover()
  }
}

/** The skip list as the watchdog needs it. */
export interface PickerSkips {
  isSkipped: (host: string) => boolean
  isRuledOut: (host: string) => boolean
  learn: (host: string) => void
  ruleOut: (host: string) => void
}

function hostOf(url: string): string {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : ''
  } catch {
    return ''
  }
}

/** Watch one tab. `skips` is a getter because the service is created lazily. */
export function wireFreezeWatchdog(wc: WebContents, skips: () => PickerSkips | null): void {
  let timer: NodeJS.Timeout | null = null
  const stop = (): void => {
    if (timer) clearInterval(timer)
    timer = null
  }
  const dog = new FreezeWatchdog({
    probe: () =>
      new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS)
        const done = (ok: boolean): void => {
          clearTimeout(t)
          resolve(ok)
        }
        if (!wc.debugger.isAttached()) return done(true) // nothing to ask through
        wc.debugger.sendCommand('Runtime.evaluate', { expression: '1' }).then(
          () => done(true),
          () => done(true) // a navigation in flight, not a frozen page
        )
      }),
    cpuPercent: () => {
      const pid = wc.getOSProcessId()
      // Electron averages over all cores: one saturated core reads 8.33 on 12 cores.
      const share = app.getAppMetrics().find((m) => m.pid === pid)?.cpu.percentCPUUsage ?? 0
      return share * cpus().length
    },
    host: () => hostOf(wc.getURL()),
    isSkipped: (host) => skips()?.isSkipped(host) ?? true,
    isRuledOut: (host) => skips()?.isRuledOut(host) ?? true,
    learn: (host) => skips()?.learn(host),
    ruleOut: (host) => skips()?.ruleOut(host),
    recover: () => {
      // terminateExecution reaches a blocked thread; a reload alone may wait on it.
      wc.debugger.sendCommand('Runtime.terminateExecution').catch(() => {})
      setTimeout(() => {
        if (!wc.isDestroyed()) wc.reload()
      }, 300)
    },
    log: (message) => console.warn(`[mira] freeze watchdog: ${message}`),
    now: Date.now
  })
  const diagnosing = (): boolean => isFreezeProbeArmed(wc.debugger as unknown as ProbeDebugger)
  const start = (): void => {
    if (!hostOf(wc.getURL())) return
    dog.onNavigate()
    timer ??= setInterval(() => {
      if (wc.isDestroyed() || !dog.active) return stop()
      // Someone is diagnosing this tab: reloading would destroy what they are looking at.
      if (diagnosing()) return stop()
      void dog.tick().catch(stop) // the tab died during the probe
    }, TICK_MS)
    timer.unref?.()
  }
  wc.on('did-navigate', start)
  wc.on('did-navigate-in-page', (_e, _url, isMainFrame) => {
    if (isMainFrame) start()
  })
  wc.once('destroyed', stop)
}
