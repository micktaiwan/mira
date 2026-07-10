import { describe, it, expect } from 'vitest'
import {
  composePrompt,
  buildAnthropicRequest,
  parseAnthropicResponse,
  buildClaudeCliArgs,
  chatSystemPrompt,
  buildAnthropicChatRequest,
  composeChatPrompt,
  CHAT_SYSTEM_PROMPT,
  DEFAULT_ANTHROPIC_MODEL,
  type LlmConfig,
  type ChatMessage
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

const THREAD: ChatMessage[] = [
  { role: 'user', text: 'What is this about?' },
  { role: 'assistant', text: 'A deadline.' },
  { role: 'user', text: 'When?' }
]

describe('chatSystemPrompt', () => {
  it('appends the page text as context when there is one', () => {
    const s = chatSystemPrompt('  The launch is on Friday.  ')
    expect(s).toContain(CHAT_SYSTEM_PROMPT)
    expect(s).toContain('Page content:\n\nThe launch is on Friday.')
  })

  it('omits the page section when the page yields nothing', () => {
    expect(chatSystemPrompt('   ')).toBe(CHAT_SYSTEM_PROMPT)
  })
})

describe('buildAnthropicChatRequest', () => {
  const cfg: LlmConfig = { provider: 'anthropic-api', apiKey: 'sk-test' }

  it('maps the whole thread to the messages array with the context as system', () => {
    const req = buildAnthropicChatRequest(cfg, 'CONTEXT', THREAD)
    expect(req.body.system).toBe('CONTEXT')
    expect(req.body.messages).toEqual([
      { role: 'user', content: 'What is this about?' },
      { role: 'assistant', content: 'A deadline.' },
      { role: 'user', content: 'When?' }
    ])
  })

  it('refuses to build a request with no API key', () => {
    expect(() => buildAnthropicChatRequest({ provider: 'anthropic-api' }, 's', THREAD)).toThrow(
      /key/i
    )
  })
})

describe('composeChatPrompt', () => {
  it('flattens the thread into a labelled transcript ending on an Assistant cue', () => {
    expect(composeChatPrompt('CONTEXT', THREAD)).toBe(
      'CONTEXT\n\n---\n\n' +
        'User: What is this about?\n\n' +
        'Assistant: A deadline.\n\n' +
        'User: When?\n\n' +
        'Assistant:'
    )
  })
})
