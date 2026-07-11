import { describe, it, expect, vi } from 'vitest'
import { LlmRunner, type LlmRunnerDeps } from './llm-runner'
import {
  composePrompt,
  composeChatPrompt,
  buildAnthropicRequest,
  buildAnthropicChatRequest,
  buildClaudeStreamInput,
  chatSystemPrompt,
  type LlmConfig,
  type ChatMessage,
  type PageContext
} from './llm'
import { extractiveSummary } from './skills'

// A fetch that always returns the same Anthropic-shaped JSON, so the anthropic-api
// path exercises build + parse without a network. Records the args it was called
// with so a test can assert the request the runner built.
function fakeFetch(json: unknown): { fn: typeof fetch; calls: unknown[][] } {
  const calls: unknown[][] = []
  const fn = (async (...args: unknown[]) => {
    calls.push(args)
    return { json: async () => json } as Response
  }) as unknown as typeof fetch
  return { fn, calls }
}

const ANTHROPIC_JSON = { content: [{ type: 'text', text: 'api answer' }] }

/** A runner whose two CLI edges are spies (so the claude-cli branches are testable
 * without a binary) and whose fetch returns ANTHROPIC_JSON. Overridable per test. */
function makeRunner(over?: Partial<LlmRunnerDeps>): {
  runner: LlmRunner
  cli: ReturnType<typeof vi.fn>
  stream: ReturnType<typeof vi.fn>
  fetchCalls: unknown[][]
} {
  const cli = vi.fn(async () => 'cli answer')
  const stream = vi.fn(async () => 'stream answer')
  const { fn, calls } = fakeFetch(ANTHROPIC_JSON)
  const runner = new LlmRunner({
    runClaudeCli: cli,
    runClaudeCliStream: stream,
    fetchFn: fn,
    ...over
  })
  return { runner, cli, stream, fetchCalls: calls }
}

describe('LlmRunner.run — provider dispatch', () => {
  it('extractive summarizes the page text and ignores the prompt/CLI/API', async () => {
    const { runner, cli, stream, fetchCalls } = makeRunner()
    const text = 'First sentence here. Second sentence here. Third one.'
    const out = await runner.run({ provider: 'extractive' }, 'Summarize.', text)
    expect(out).toBe(extractiveSummary(text))
    expect(cli).not.toHaveBeenCalled()
    expect(stream).not.toHaveBeenCalled()
    expect(fetchCalls).toHaveLength(0)
  })

  it('anthropic-api posts the built request and parses the response text', async () => {
    const cfg: LlmConfig = { provider: 'anthropic-api', apiKey: 'sk-test' }
    const { runner, cli, fetchCalls } = makeRunner()
    const out = await runner.run(cfg, 'Summarize.', 'Hello world.')
    expect(out).toBe('api answer')
    expect(cli).not.toHaveBeenCalled()
    // The URL + body handed to fetch match the pure builder exactly.
    const req = buildAnthropicRequest(cfg, 'Summarize.', 'Hello world.')
    expect(fetchCalls[0][0]).toBe(req.url)
    const init = fetchCalls[0][1] as RequestInit
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify(req.body))
  })

  it('claude-cli feeds the composed prompt to the CLI edge', async () => {
    const cfg: LlmConfig = { provider: 'claude-cli' }
    const { runner, cli, stream } = makeRunner()
    const out = await runner.run(cfg, 'Summarize.', 'Body text.')
    expect(out).toBe('cli answer')
    expect(stream).not.toHaveBeenCalled()
    expect(cli).toHaveBeenCalledWith(cfg, composePrompt('Summarize.', 'Body text.'))
  })
})

describe('LlmRunner.chat — provider dispatch', () => {
  const thread: ChatMessage[] = [
    { role: 'user', text: 'What is this?' },
    { role: 'assistant', text: 'A page.' },
    { role: 'user', text: 'Summarize it.' }
  ]
  const page: PageContext = { url: 'https://example.com', text: 'Alpha beta. Gamma delta.' }

  it('extractive summarizes the page text when there is one', async () => {
    const { runner } = makeRunner()
    const out = await runner.chat({ provider: 'extractive' }, thread, page)
    expect(out).toBe(extractiveSummary(page.text))
  })

  it('extractive echoes the last question when the page has no text', async () => {
    const { runner } = makeRunner()
    const empty: PageContext = { url: 'https://example.com', text: '   ' }
    const out = await runner.chat({ provider: 'extractive' }, thread, empty)
    expect(out).toBe(extractiveSummary('Summarize it.'))
  })

  it('anthropic-api posts the built chat request and parses it', async () => {
    const cfg: LlmConfig = { provider: 'anthropic-api', apiKey: 'sk-test' }
    const { runner, fetchCalls } = makeRunner()
    const out = await runner.chat(cfg, thread, page)
    expect(out).toBe('api answer')
    const system = chatSystemPrompt(page.url, page.text)
    const req = buildAnthropicChatRequest(cfg, system, thread, page.screenshot)
    expect(fetchCalls[0][0]).toBe(req.url)
    expect((fetchCalls[0][1] as RequestInit).body).toBe(JSON.stringify(req.body))
  })

  it('claude-cli text-only turn uses the plain CLI edge', async () => {
    const cfg: LlmConfig = { provider: 'claude-cli' }
    const { runner, cli, stream } = makeRunner()
    const out = await runner.chat(cfg, thread, page)
    expect(out).toBe('cli answer')
    expect(stream).not.toHaveBeenCalled()
    const system = chatSystemPrompt(page.url, page.text)
    expect(cli).toHaveBeenCalledWith(cfg, composeChatPrompt(system, thread))
  })

  it('claude-cli routes a screenshot turn through the stream-json edge', async () => {
    const cfg: LlmConfig = { provider: 'claude-cli' }
    const png = 'data:image/png;base64,ZmFrZQ=='
    const shot: PageContext = { ...page, screenshot: png }
    const { runner, cli, stream } = makeRunner()
    const out = await runner.chat(cfg, thread, shot)
    expect(out).toBe('stream answer')
    expect(cli).not.toHaveBeenCalled()
    const system = chatSystemPrompt(shot.url, shot.text)
    expect(stream).toHaveBeenCalledWith(cfg, buildClaudeStreamInput(system, thread, png))
  })
})
