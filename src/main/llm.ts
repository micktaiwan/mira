// The LLM engine behind skills: turn a system prompt + page text into a summary.
// Two real providers plus a local fallback, chosen in Settings:
//   - 'claude-cli'    : shell out to `claude -p` (Claude Code print mode), which
//                       uses Mickael's logged-in subscription — no API key, no cost.
//   - 'anthropic-api' : POST the Anthropic Messages API with a stored key.
//   - 'extractive'    : the dependency-free local lead-sentence summary (skills.ts).
//
// This file holds ONLY the PURE pieces (request building, response parsing, argv
// assembly) so the provider contracts are unit-tested without network or spawning.
// The actual fetch / child_process calls are the native edge and live in
// profiles.ts (the `summarize` context method), like every other Electron-bound bit.

export type LlmProvider = 'claude-cli' | 'anthropic-api' | 'extractive'

/** The persisted LLM configuration (part of AppSettings). */
export interface LlmConfig {
  provider: LlmProvider
  /** Anthropic API key — only for 'anthropic-api'. */
  apiKey?: string
  /** Optional model override. Empty → the provider's own default. */
  model?: string
}

/** Default model for the Anthropic API path (a fast, cheap summarizer). The CLI
 * path leaves the model unset so it uses whatever the subscription defaults to. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'

/** The set of valid providers, so settings / commands can validate input. */
export const LLM_PROVIDERS: readonly LlmProvider[] = ['claude-cli', 'anthropic-api', 'extractive']

/** Combine a skill's system prompt and the extracted page text into one prompt
 * string. Used by the CLI path (which has no separate system role) and anywhere a
 * single blob is needed. Pure. */
export function composePrompt(systemPrompt: string, text: string): string {
  return `${systemPrompt.trim()}\n\n---\n\n${text.trim()}`
}

/** The Anthropic Messages API request for a summary. Pure: no fetch, just the
 * shape. `system` carries the skill prompt; the page text is the user message. */
export function buildAnthropicRequest(
  config: LlmConfig,
  systemPrompt: string,
  text: string
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  if (!config.apiKey || config.apiKey.trim() === '') {
    throw new Error('Anthropic API key is not set (Settings → AI)')
  }
  return {
    url: 'https://api.anthropic.com/v1/messages',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: {
      model: config.model?.trim() || DEFAULT_ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: text }]
    }
  }
}

/** Pull the text out of an Anthropic Messages API response, or throw on an error
 * payload / unexpected shape. Pure. */
export function parseAnthropicResponse(json: unknown): string {
  if (!json || typeof json !== 'object') throw new Error('empty LLM response')
  const obj = json as Record<string, unknown>
  if (obj.type === 'error') {
    const err = obj.error as { message?: string } | undefined
    throw new Error(err?.message ? `Anthropic API: ${err.message}` : 'Anthropic API error')
  }
  const content = obj.content
  if (!Array.isArray(content)) throw new Error('LLM response has no content')
  const text = content
    .map((block) => (block && typeof block === 'object' ? (block as { text?: string }).text : ''))
    .filter((t): t is string => typeof t === 'string')
    .join('')
    .trim()
  if (text === '') throw new Error('LLM returned no text')
  return text
}

/** The argv for `claude -p` (print / non-interactive mode). The prompt itself is
 * fed on stdin (not argv) to sidestep shell escaping and arg-length limits. Pure. */
export function buildClaudeCliArgs(config: LlmConfig): string[] {
  const args = ['-p']
  if (config.model && config.model.trim() !== '') args.push('--model', config.model.trim())
  return args
}
