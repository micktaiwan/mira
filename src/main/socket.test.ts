import { describe, it, expect } from 'vitest'
import { handleRequestLine } from './socket'
import { createCommandRegistry, type CommandContext } from './commands'

function setup(): {
  registry: ReturnType<typeof createCommandRegistry>
  ctx: CommandContext
  loaded: string[]
} {
  const loaded: string[] = []
  let focused = 'default'
  const ctx: CommandContext = {
    getTargetWebContents: () => ({
      loadURL: (url: string) => {
        loaded.push(url)
      }
    }),
    getTargetProfile: () => focused,
    openProfile: (name: string) => {
      focused = name
      return { profile: name, created: true }
    },
    listProfiles: () => ({ profiles: [focused], focused })
  }
  return { registry: createCommandRegistry(), ctx, loaded }
}

describe('handleRequestLine', () => {
  it('dispatches a valid navigate request to the registry', () => {
    const { registry, ctx, loaded } = setup()
    const res = handleRequestLine(
      '{"command":"navigate","params":{"url":"example.com"}}',
      registry,
      ctx
    )
    expect(res).toEqual({ ok: true, url: 'https://example.com' })
    expect(loaded).toEqual(['https://example.com'])
  })

  it('rejects invalid JSON', () => {
    const { registry, ctx } = setup()
    expect(handleRequestLine('{not json', registry, ctx)).toEqual({
      ok: false,
      error: 'invalid JSON'
    })
  })

  it('rejects a message with no command field', () => {
    const { registry, ctx } = setup()
    expect(handleRequestLine('{"params":{}}', registry, ctx)).toEqual({
      ok: false,
      error: 'missing "command" field'
    })
  })

  it('turns an unknown command into an error response instead of throwing', () => {
    const { registry, ctx } = setup()
    expect(handleRequestLine('{"command":"fly"}', registry, ctx)).toEqual({
      ok: false,
      error: 'Unknown command: fly'
    })
  })
})
