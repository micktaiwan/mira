import { describe, it, expect } from 'vitest'
import {
  composePrompt,
  buildAnthropicRequest,
  parseAnthropicResponse,
  buildClaudeCliArgs,
  DEFAULT_ANTHROPIC_MODEL,
  type LlmConfig
} from './llm'

describe('composePrompt', () => {
  it('joins the system prompt and the page text with a separator', () => {
    expect(composePrompt('  Summarize this.  ', '  Body text.  ')).toBe(
      'Summarize this.\n\n---\n\nBody text.'
    )
  })
})

describe('buildAnthropicRequest', () => {
  const cfg: LlmConfig = { provider: 'anthropic-api', apiKey: 'sk-test' }

  it('carries the key, version, system prompt and user text', () => {
    const req = buildAnthropicRequest(cfg, 'Summarize.', 'Hello world.')
    expect(req.url).toBe('https://api.anthropic.com/v1/messages')
    expect(req.headers['x-api-key']).toBe('sk-test')
    expect(req.headers['anthropic-version']).toBe('2023-06-01')
    expect(req.body.system).toBe('Summarize.')
    expect(req.body.messages).toEqual([{ role: 'user', content: 'Hello world.' }])
  })

  it('defaults the model but honors an override', () => {
    expect(buildAnthropicRequest(cfg, 's', 't').body.model).toBe(DEFAULT_ANTHROPIC_MODEL)
    expect(buildAnthropicRequest({ ...cfg, model: 'claude-opus-4-8' }, 's', 't').body.model).toBe(
      'claude-opus-4-8'
    )
  })

  it('refuses to build a request with no API key', () => {
    expect(() => buildAnthropicRequest({ provider: 'anthropic-api' }, 's', 't')).toThrow(/key/i)
  })
})

describe('parseAnthropicResponse', () => {
  it('extracts and concatenates text blocks', () => {
    const json = {
      content: [
        { type: 'text', text: 'Sum' },
        { type: 'text', text: 'mary' }
      ]
    }
    expect(parseAnthropicResponse(json)).toBe('Summary')
  })

  it('throws with the API message on an error payload', () => {
    expect(() =>
      parseAnthropicResponse({ type: 'error', error: { message: 'overloaded' } })
    ).toThrow(/overloaded/)
  })

  it('throws on a shape with no usable text', () => {
    expect(() => parseAnthropicResponse({ content: [] })).toThrow()
    expect(() => parseAnthropicResponse(null)).toThrow()
  })
})

describe('buildClaudeCliArgs', () => {
  it('runs in print mode with no model by default', () => {
    expect(buildClaudeCliArgs({ provider: 'claude-cli' })).toEqual(['-p'])
  })

  it('passes an explicit model through', () => {
    expect(buildClaudeCliArgs({ provider: 'claude-cli', model: 'claude-sonnet-5' })).toEqual([
      '-p',
      '--model',
      'claude-sonnet-5'
    ])
  })
})
