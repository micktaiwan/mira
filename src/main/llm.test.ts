import { describe, it, expect } from 'vitest'
import {
  composePrompt,
  buildAnthropicRequest,
  parseAnthropicResponse,
  buildClaudeCliArgs,
  claudeBinCandidates,
  claudeSpawnPath,
  chatSystemPrompt,
  buildAnthropicChatRequest,
  composeChatPrompt,
  parseDataUrl,
  buildClaudeStreamArgs,
  buildClaudeStreamInput,
  parseClaudeStreamResult,
  CHAT_SYSTEM_PROMPT,
  CHAT_WEB_ONLY_PROMPT,
  CHAT_WEB_TOOLS,
  DEFAULT_ANTHROPIC_MODEL,
  MODEL_CHOICES,
  type LlmConfig,
  type ChatMessage
} from './llm'

const PNG = 'data:image/png;base64,ZmFrZQ=='

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
  it('clamps to a lookup-only chat by default: no MCP, web tools only, no phantom agency', () => {
    expect(buildClaudeCliArgs({ provider: 'claude-cli' })).toEqual([
      '-p',
      '--strict-mcp-config',
      '--tools',
      CHAT_WEB_TOOLS,
      '--allowedTools',
      CHAT_WEB_TOOLS,
      '--append-system-prompt',
      CHAT_WEB_ONLY_PROMPT
    ])
  })

  it('opens up to the full agent (MCP + tools) when the user opts in', () => {
    expect(buildClaudeCliArgs({ provider: 'claude-cli', loadMcp: true })).toEqual(['-p'])
  })

  it('passes an explicit model through, still clamped by default', () => {
    expect(buildClaudeCliArgs({ provider: 'claude-cli', model: 'claude-sonnet-5' })).toEqual([
      '-p',
      '--strict-mcp-config',
      '--tools',
      CHAT_WEB_TOOLS,
      '--allowedTools',
      CHAT_WEB_TOOLS,
      '--append-system-prompt',
      CHAT_WEB_ONLY_PROMPT,
      '--model',
      'claude-sonnet-5'
    ])
  })

  it('combines agent mode with a model', () => {
    expect(
      buildClaudeCliArgs({ provider: 'claude-cli', model: 'claude-opus-4-8', loadMcp: true })
    ).toEqual(['-p', '--model', 'claude-opus-4-8'])
  })
})

describe('claudeBinCandidates', () => {
  it('probes the known install locations, home dirs first, bare name last', () => {
    expect(claudeBinCandidates({}, '/Users/me')).toEqual([
      '/Users/me/.local/bin/claude',
      '/Users/me/.claude/local/claude',
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      'claude'
    ])
  })

  it('puts an explicit MIRA_CLAUDE_BIN override first', () => {
    expect(claudeBinCandidates({ MIRA_CLAUDE_BIN: '/custom/claude' }, '/Users/me')[0]).toBe(
      '/custom/claude'
    )
  })

  it('ignores a blank override and a blank home', () => {
    expect(claudeBinCandidates({ MIRA_CLAUDE_BIN: '  ' }, '')).toEqual([
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      'claude'
    ])
  })
})

describe('claudeSpawnPath', () => {
  it('prepends the user bin dirs to the existing PATH, deduped', () => {
    expect(claudeSpawnPath({ PATH: '/usr/bin:/opt/homebrew/bin' }, '/Users/me')).toBe(
      '/Users/me/.local/bin:/Users/me/.claude/local:/opt/homebrew/bin:/usr/local/bin:/usr/bin'
    )
  })

  it('handles a missing PATH', () => {
    expect(claudeSpawnPath({}, '/Users/me')).toBe(
      '/Users/me/.local/bin:/Users/me/.claude/local:/opt/homebrew/bin:/usr/local/bin'
    )
  })
})

describe('MODEL_CHOICES', () => {
  it('offers a Default that leaves the model unset, plus named models', () => {
    const byId = Object.fromEntries(MODEL_CHOICES.map((c) => [c.id, c.model]))
    expect(byId.default).toBe('')
    expect(byId.opus).toBe('claude-opus-4-8')
    expect(byId.sonnet).toBe('claude-sonnet-5')
    expect(byId.haiku).toBe(DEFAULT_ANTHROPIC_MODEL)
  })
})

const THREAD: ChatMessage[] = [
  { role: 'user', text: 'What is this about?' },
  { role: 'assistant', text: 'A deadline.' },
  { role: 'user', text: 'When?' }
]

describe('chatSystemPrompt', () => {
  it('includes the URL and the page text as context', () => {
    const s = chatSystemPrompt('https://maps.google.com/place/Ajaccio', '  The launch is Friday.  ')
    expect(s).toContain(CHAT_SYSTEM_PROMPT)
    expect(s).toContain('Current page URL: https://maps.google.com/place/Ajaccio')
    expect(s).toContain('Page content:\n\nThe launch is Friday.')
  })

  it('includes the URL even when the page yields no text', () => {
    const s = chatSystemPrompt('https://maps.google.com/place/Ajaccio', '   ')
    expect(s).toContain('Current page URL: https://maps.google.com/place/Ajaccio')
    expect(s).not.toContain('Page content:')
  })

  it('omits both sections when there is no URL and no text', () => {
    expect(chatSystemPrompt('', '   ')).toBe(CHAT_SYSTEM_PROMPT)
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

  it('rides a screenshot as an image block on the last user turn only', () => {
    const req = buildAnthropicChatRequest(cfg, 'CONTEXT', THREAD, PNG)
    const msgs = req.body.messages as Array<{ role: string; content: unknown }>
    // Earlier turns stay plain strings; the last (current) user turn carries the image.
    expect(msgs[0].content).toBe('What is this about?')
    expect(msgs[2].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZQ==' } },
      { type: 'text', text: 'When?' }
    ])
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

describe('parseDataUrl', () => {
  it('splits a base64 data URL into media type and data', () => {
    expect(parseDataUrl(PNG)).toEqual({ mediaType: 'image/png', data: 'ZmFrZQ==' })
  })

  it('returns null for a non-data URL', () => {
    expect(parseDataUrl('https://example.com/x.png')).toBeNull()
  })
})

describe('buildClaudeStreamArgs', () => {
  it('runs print mode with stream-json in/out, --verbose, and clamped by default', () => {
    expect(buildClaudeStreamArgs({ provider: 'claude-cli' })).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--strict-mcp-config',
      '--tools',
      CHAT_WEB_TOOLS,
      '--allowedTools',
      CHAT_WEB_TOOLS,
      '--append-system-prompt',
      CHAT_WEB_ONLY_PROMPT
    ])
  })

  it('drops the lock-down (MCP + tools + agency prompt) in agent mode', () => {
    const args = buildClaudeStreamArgs({ provider: 'claude-cli', loadMcp: true })
    expect(args).not.toContain('--strict-mcp-config')
    expect(args).not.toContain('--tools')
    expect(args).not.toContain('--append-system-prompt')
  })

  it('appends a model override', () => {
    expect(buildClaudeStreamArgs({ provider: 'claude-cli', model: 'claude-opus-4-8' })).toContain(
      'claude-opus-4-8'
    )
  })
})

describe('buildClaudeStreamInput', () => {
  it('wraps the transcript and image into one user-message NDJSON line', () => {
    const line = buildClaudeStreamInput('CONTEXT', THREAD, PNG)
    expect(line.endsWith('\n')).toBe(true)
    const obj = JSON.parse(line.trim())
    expect(obj.type).toBe('user')
    expect(obj.message.role).toBe('user')
    // Image block first, then the composed transcript as a text block.
    expect(obj.message.content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZQ==' }
    })
    expect(obj.message.content[1].type).toBe('text')
    expect(obj.message.content[1].text).toContain('User: When?')
  })
})

describe('parseClaudeStreamResult', () => {
  const stream = [
    '{"type":"system","subtype":"init"}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Ajaccio"}]}}',
    '{"type":"result","subtype":"success","is_error":false,"result":"Ajaccio, Corsica."}'
  ].join('\n')

  it('extracts the text from the result line', () => {
    expect(parseClaudeStreamResult(stream)).toBe('Ajaccio, Corsica.')
  })

  it('throws with the error result message', () => {
    expect(() =>
      parseClaudeStreamResult('{"type":"result","subtype":"error","is_error":true,"result":"boom"}')
    ).toThrow(/boom/)
  })

  it('throws when there is no result line', () => {
    expect(() => parseClaudeStreamResult('{"type":"system","subtype":"init"}')).toThrow(/no result/)
  })
})
