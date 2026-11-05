import { describe, it, expect, afterEach } from 'vitest'
import {
  createQuitGate,
  installQuitGate,
  allowQuitNow,
  suppressQuitPrompt,
  resetQuitGate,
  noteQuitOrigin,
  currentQuitOrigin,
  quitVaultStep,
  QUIT_CONFIRM
} from './quit'

/** A prompt whose answer is decided by the test, resolved on demand. */
function deferredPrompt(): {
  prompt: () => Promise<boolean>
  calls: number
  answer: (ok: boolean) => Promise<void>
} {
  let resolve: ((ok: boolean) => void) | null = null
  const state = {
    calls: 0,
    prompt: () => {
      state.calls++
      return new Promise<boolean>((r) => {
        resolve = r
      })
    },
    answer: async (ok: boolean) => {
      resolve?.(ok)
      // Let the gate's .then run before the test asserts.
      await Promise.resolve()
      await Promise.resolve()
    }
  }
  return state
}

describe('createQuitGate', () => {
  it('blocks the first quit and asks', () => {
    const p = deferredPrompt()
    const gate = createQuitGate({ prompt: p.prompt, quit: () => {} })
    expect(gate.allowQuit()).toBe(false)
    expect(p.calls).toBe(1)
  })

  it('re-quits once the user confirms, and then lets it through', async () => {
    const p = deferredPrompt()
    const quits: number[] = []
    const gate = createQuitGate({ prompt: p.prompt, quit: () => quits.push(1) })
    gate.allowQuit()
    await p.answer(true)
    expect(quits).toHaveLength(1)
    expect(gate.allowQuit()).toBe(true)
  })

  it('does not quit when the user cancels, and asks again next time', async () => {
    const p = deferredPrompt()
    const quits: number[] = []
    const gate = createQuitGate({ prompt: p.prompt, quit: () => quits.push(1) })
    gate.allowQuit()
    await p.answer(false)
    expect(quits).toHaveLength(0)
    expect(gate.allowQuit()).toBe(false)
    expect(p.calls).toBe(2)
  })

  it('does not stack a second dialog while one is up', () => {
    const p = deferredPrompt()
    const gate = createQuitGate({ prompt: p.prompt, quit: () => {} })
    gate.allowQuit()
    gate.allowQuit()
    gate.allowQuit()
    expect(p.calls).toBe(1)
  })

  it('asks again after a failed prompt instead of staying stuck', async () => {
    let calls = 0
    const gate = createQuitGate({
      prompt: () => {
        calls++
        return Promise.reject(new Error('no window'))
      },
      quit: () => {}
    })
    expect(gate.allowQuit()).toBe(false)
    await Promise.resolve()
    await Promise.resolve()
    expect(gate.allowQuit()).toBe(false)
    expect(calls).toBe(2)
  })

  it('lets a suppressed quit through without asking (scripts, signals)', () => {
    const p = deferredPrompt()
    const gate = createQuitGate({ prompt: p.prompt, quit: () => {} })
    gate.suppress('socket')
    expect(gate.allowQuit()).toBe(true)
    expect(p.calls).toBe(0)
  })

  it('lets the follow-up app quit through after a confirmed last-window close', async () => {
    // profiles.ts holds the window close, asks, then app.quit() re-enters the gate
    // via 'before-quit' — which must not ask a second time.
    const p = deferredPrompt()
    const quits: number[] = []
    const gate = createQuitGate({ prompt: p.prompt, quit: () => quits.push(1) })
    expect(gate.allowQuit()).toBe(false)
    await p.answer(true)
    expect(quits).toHaveLength(1)
    expect(gate.allowQuit()).toBe(true)
    expect(p.calls).toBe(1)
  })

  it('stays confirmed across the extra before-quit passes of the vault re-lock', async () => {
    const p = deferredPrompt()
    const gate = createQuitGate({ prompt: p.prompt, quit: () => {} })
    gate.allowQuit()
    await p.answer(true)
    expect(gate.allowQuit()).toBe(true)
    expect(gate.allowQuit()).toBe(true)
    expect(p.calls).toBe(1)
  })
})

describe('the installed gate', () => {
  afterEach(() => resetQuitGate())

  it('allows the quit when no gate is installed yet (early boot)', () => {
    expect(allowQuitNow()).toBe(true)
  })

  it('routes through the installed gate once wired', () => {
    const p = deferredPrompt()
    installQuitGate(createQuitGate({ prompt: p.prompt, quit: () => {} }))
    expect(allowQuitNow()).toBe(false)
    expect(p.calls).toBe(1)
  })

  it('suppressQuitPrompt lets the next quit through', () => {
    const p = deferredPrompt()
    installQuitGate(createQuitGate({ prompt: p.prompt, quit: () => {} }))
    suppressQuitPrompt('signal')
    expect(allowQuitNow()).toBe(true)
    expect(p.calls).toBe(0)
  })

  it('suppressQuitPrompt is a no-op with no gate installed', () => {
    expect(() => suppressQuitPrompt('signal')).not.toThrow()
  })
})

describe('QUIT_CONFIRM', () => {
  it('names the two buttons the dialog offers', () => {
    expect(QUIT_CONFIRM.quitLabel).toBe('Quit')
    expect(QUIT_CONFIRM.cancelLabel).toBe('Cancel')
  })
})

describe('confirmedByUser', () => {
  it('is true only for a quit a person confirmed, never for a scripted one', async () => {
    const p = deferredPrompt()
    const gate = createQuitGate({ prompt: p.prompt, quit: () => {} })
    expect(gate.confirmedByUser()).toBe(false)
    gate.allowQuit()
    await p.answer(true)
    expect(gate.confirmedByUser()).toBe(true)

    const scripted = createQuitGate({ prompt: p.prompt, quit: () => {} })
    scripted.suppress('socket')
    expect(scripted.confirmedByUser()).toBe(false)
  })
})

describe('quitVaultStep', () => {
  const none = new Set<string>()

  it('holds any quit back while the quit-time lock is running', () => {
    // A second Cmd+Q mid-lock must not exit before the vault copy is done.
    expect(quitVaultStep({ lockRunning: true, unlocked: ['a'], failed: none })).toBe('wait')
    expect(quitVaultStep({ lockRunning: true, unlocked: [], failed: none })).toBe('wait')
  })

  it('locks what is unlocked, and proceeds when nothing is', () => {
    expect(quitVaultStep({ lockRunning: false, unlocked: ['a'], failed: none })).toBe('lock')
    expect(quitVaultStep({ lockRunning: false, unlocked: [], failed: none })).toBe('proceed')
  })

  it('does not retry a vault whose lock failed, or the quit would loop', () => {
    const failed = new Set(['a'])
    expect(quitVaultStep({ lockRunning: false, unlocked: ['a'], failed })).toBe('proceed')
    // A vault unlocked again after a cancelled quit is still locked.
    expect(quitVaultStep({ lockRunning: false, unlocked: ['a', 'b'], failed })).toBe('lock')
  })
})

describe('quit origin log', () => {
  afterEach(() => resetQuitGate())

  function loggedGate(): {
    gate: ReturnType<typeof createQuitGate>
    p: ReturnType<typeof deferredPrompt>
    lines: string[]
    tick: (ms: number) => void
  } {
    const p = deferredPrompt()
    const lines: string[] = []
    let t = 1000
    const gate = createQuitGate({
      prompt: p.prompt,
      quit: () => {},
      log: (l) => lines.push(l),
      now: () => t
    })
    return { gate, p, lines, tick: (ms) => (t += ms) }
  }

  it('logs the noted origin when it asks, then the answer and how long it took', async () => {
    const { gate, p, lines, tick } = loggedGate()
    gate.noteOrigin('cmd-q')
    gate.allowQuit()
    tick(1400)
    await p.answer(true)
    expect(lines).toEqual([
      '[mira-quit] asking (origin=cmd-q)',
      '[mira-quit] answered quit after 1400ms'
    ])
    expect(gate.origin()).toBe('cmd-q')
  })

  it('calls a quit that went through none of our paths "system" (Dock, AppleScript, logout)', () => {
    const { gate, lines } = loggedGate()
    gate.allowQuit()
    expect(lines[0]).toBe('[mira-quit] asking (origin=system)')
  })

  it('logs a cancel', async () => {
    const { gate, p, lines } = loggedGate()
    gate.noteOrigin('last-window-close')
    gate.allowQuit()
    await p.answer(false)
    expect(lines[1]).toBe('[mira-quit] answered cancel after 0ms')
  })

  it('never credits a stale note to a later quit', async () => {
    const { gate, p, lines } = loggedGate()
    gate.noteOrigin('menu')
    gate.allowQuit()
    await p.answer(false)
    gate.allowQuit()
    expect(lines[2]).toBe('[mira-quit] asking (origin=system)')
  })

  it('logs a second request made while the dialog is up', () => {
    const { gate, lines } = loggedGate()
    gate.allowQuit()
    gate.noteOrigin('cmd-q')
    gate.allowQuit()
    expect(lines[1]).toBe('[mira-quit] asked again while the dialog is up (origin=cmd-q)')
  })

  it('keeps the origin of a scripted quit', () => {
    const { gate, lines } = loggedGate()
    gate.suppress('socket')
    expect(gate.allowQuit()).toBe(true)
    expect(gate.origin()).toBe('socket')
    expect(lines).toEqual([])
  })

  it('routes noteQuitOrigin / currentQuitOrigin through the installed gate', () => {
    expect(currentQuitOrigin()).toBe('system')
    const { gate } = loggedGate()
    installQuitGate(gate)
    noteQuitOrigin('menu')
    allowQuitNow()
    expect(currentQuitOrigin()).toBe('menu')
  })
})
