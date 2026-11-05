import { describe, expect, it, vi } from 'vitest'
import { freezeCommands } from './freeze'
import type { CommandContext } from './context'

const probe = { responsive: false, armed: true, samplesTaken: 1, stacks: [], timeline: [] }

function ctx(): CommandContext {
  return {
    armFreezeProbe: vi.fn(async () => ({ armed: true as const, alreadyArmed: false })),
    runFreezeProbe: vi.fn(async () => probe)
  } as unknown as CommandContext
}

describe('freeze commands', () => {
  it('arms the named tab', async () => {
    const c = ctx()
    expect(await freezeCommands['arm-freeze-probe'](c, { tabId: 't' })).toEqual({
      ok: true,
      armed: true,
      alreadyArmed: false
    })
    expect(c.armFreezeProbe).toHaveBeenCalledWith('t')
  })

  it('passes the options and returns the probe', async () => {
    const c = ctx()
    expect(
      await freezeCommands['freeze-probe'](c, { tabId: 't', samples: 2, terminate: true })
    ).toEqual({ ok: true, probe })
    expect(c.runFreezeProbe).toHaveBeenCalledWith('t', { samples: 2, terminate: true })
  })

  it('lists and forgets picker skips', async () => {
    const c = {
      listPickerSkips: vi.fn(() => ({ learned: ['a.test'], ruledOut: [] })),
      forgetPickerSkip: vi.fn()
    } as unknown as CommandContext
    expect(await freezeCommands['list-picker-skips'](c, undefined)).toEqual({
      ok: true,
      learned: ['a.test'],
      ruledOut: []
    })
    expect(await freezeCommands['forget-picker-skip'](c, { host: 'a.test' })).toEqual({
      ok: true,
      host: 'a.test'
    })
    expect(c.forgetPickerSkip).toHaveBeenCalledWith('a.test')
    expect(await freezeCommands['forget-picker-skip'](c, {})).toMatchObject({ ok: false })
  })

  it('refuses bad params', async () => {
    const c = ctx()
    expect(await freezeCommands['freeze-probe'](c, { samples: 0 })).toMatchObject({ ok: false })
    expect(await freezeCommands['freeze-probe'](c, { terminate: 'y' })).toMatchObject({ ok: false })
    expect(await freezeCommands['arm-freeze-probe'](c, { tabId: '' })).toMatchObject({ ok: false })
  })

  it('turns a resolution error into a failure', async () => {
    const c = ctx()
    vi.mocked(c.runFreezeProbe).mockRejectedValue(new Error('unknown tab: x'))
    expect(await freezeCommands['freeze-probe'](c, { tabId: 'x' })).toEqual({
      ok: false,
      error: 'unknown tab: x'
    })
  })
})
