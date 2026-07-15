// The LLM engine behind skills: turn a system prompt + page text into a summary.
// Two real providers plus a local fallback, chosen in Settings:
//   - 'claude-cli'    : shell out to `claude -p` (Claude Code print mode), which
//                       uses the logged-in Claude subscription — no API key, no cost.
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
  /** Only 'claude-cli': load the user's MCP servers into each call. Off by default
   * (and absent = off) because a full session boots every configured MCP server
   * (~35k tokens + connection latency) and could even fire a tool mid-answer — a
   * page chat needs none of that. Off → the CLI runs with --strict-mcp-config (zero
   * servers). Ignored by the API / extractive providers. */
  loadMcp?: boolean
}

/** Default model for the Anthropic API path (a fast, cheap summarizer). The CLI
 * path leaves the model unset so it uses whatever the subscription defaults to. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'

/** The set of valid providers, so settings / commands can validate input. */
export const LLM_PROVIDERS: readonly LlmProvider[] = ['claude-cli', 'anthropic-api', 'extractive']

/** One selectable model in the chat's options bar. `model` is the argv/API string
 * ('' = let the provider/subscription pick its own default); `id`/`label` are for
 * the UI. Kept here (pure) so the pane and the CLI/API paths agree on the set. */
export interface ModelChoice {
  id: string
  label: string
  model: string
}

/** The models the pane's options bar offers. "Default" ('') leaves the model unset,
 * so claude-cli uses the subscription default and the API uses DEFAULT_ANTHROPIC_MODEL. */
export const MODEL_CHOICES: readonly ModelChoice[] = [
  { id: 'default', label: 'Default', model: '' },
  { id: 'haiku', label: 'Haiku', model: 'claude-haiku-4-5-20251001' },
  { id: 'sonnet', label: 'Sonnet', model: 'claude-sonnet-5' },
  { id: 'opus', label: 'Opus', model: 'claude-opus-4-8' }
]

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
  if (!config.loadMcp) args.push(...chatClampArgs())
  if (config.model && config.model.trim() !== '') args.push('--model', config.model.trim())
  return args
}

/** The built-in tools the non-agent chat is allowed to use. WebSearch + WebFetch
 * are pure lookups (they read the web, they don't touch the machine or the
 * browser), so a plain page chat can still look things up — the floor Mickael
 * wants. Everything else (Bash, Edit, MCP…) stays off unless the user flips the
 * Agent toggle (loadMcp). */
export const CHAT_WEB_TOOLS = 'WebSearch,WebFetch'

/** The argv clamp for the non-agent (default) chat. `claude -p` is the full Claude
 * Code AGENT; left alone it uses Bash, MCP servers, etc. and tries to *act*. This
 * pins it to a lookup-only chat:
 *   --strict-mcp-config (no --mcp-config) → ZERO MCP servers (also cuts the
 *       full-session boot cost/latency).
 *   --tools WebSearch,WebFetch → only the two web-lookup tools from the built-in
 *       set; the rest of the agent tool surface stays disabled.
 *   --allowedTools WebSearch,WebFetch → pre-approve them, else in non-interactive
 *       `-p` mode WebFetch's per-domain permission prompt would deny the call.
 *   --append-system-prompt → tell it plainly what it can and can't do, so it uses
 *       the web tools when useful and doesn't emit phantom calls for the rest.
 * Shared by the plain and stream-json paths so they stay in lockstep. Pure. */
export function chatClampArgs(): string[] {
  return [
    '--strict-mcp-config',
    '--tools',
    CHAT_WEB_TOOLS,
    '--allowedTools',
    CHAT_WEB_TOOLS,
    '--append-system-prompt',
    CHAT_WEB_ONLY_PROMPT
  ]
}

// --- Chat (multi-turn) --------------------------------------------------------
// The pane is a conversation: the free-form prompt box (run-prompt) sends the
// whole thread each turn, so the model keeps context. A skill is still one-shot
// (buildAnthropicRequest / composePrompt above); these are the chat path.

/** One turn of the pane conversation. Crosses IPC as part of SkillPaneState (see
 * commands/pane.ts, which re-exports this type). */
export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
}

/** What the assistant knows about the page a chat turn is about: its URL, its
 * extracted text, and — ONLY when the user explicitly asks (the 📷 button) — a
 * screenshot (a PNG data URL). Assembled by run-prompt from the native edges
 * (activeUrl / extractText / capturePage). */
export interface PageContext {
  url: string
  text: string
  /** A PNG `data:` URL screenshot, present only when the user attached one for
   * this turn. Vision providers (anthropic-api, claude-cli via stream-json) send
   * it as an image; the extractive path ignores it. Never sent automatically. */
  screenshot?: string
}

/** Base instruction for the free-form page chat. The current page's URL and text
 * are appended so answers can draw on what the user is looking at. */
export const CHAT_SYSTEM_PROMPT =
  "You are a helpful assistant embedded in a web browser. Answer the user's " +
  'questions clearly and concisely. Use the current page (its URL and its text) ' +
  'as the context for the conversation.'

/** Appended to `claude -p`'s own system prompt in non-agent (default) mode. The
 * chat has EXACTLY two tools — WebSearch and WebFetch (see chatClampArgs) — and no
 * other agency: no shell, no filesystem, no control over the browser. Left to its
 * own devices `claude -p` (full Claude Code under the hood) emits phantom tool-call
 * markup for things it can't do; this tells it plainly what it has, so it uses the
 * web tools when a question needs current/external facts and says so in one
 * sentence when asked for anything else. */
export const CHAT_WEB_ONLY_PROMPT =
  'You are a chat assistant embedded in a web browser. You have exactly two tools: ' +
  'WebSearch (to search the web) and WebFetch (to read a URL). Use them when a ' +
  'question needs current or external information beyond the conversation and the ' +
  'provided page context. You have NO other tools: no shell, no filesystem, and no ' +
  'ability to control the browser. If asked to do something outside answering and ' +
  'web lookups, say so plainly in one sentence.'

/** The system prompt for a chat turn: the base instruction plus the current
 * page's URL and text as context (each omitted when absent). Pure. */
export function chatSystemPrompt(url: string, pageText: string): string {
  const parts = [CHAT_SYSTEM_PROMPT]
  if (url.trim() !== '') parts.push(`Current page URL: ${url.trim()}`)
  const t = pageText.trim()
  if (t !== '') parts.push(`Page content:\n\n${t}`)
  return parts.join('\n\n---\n\n')
}

/** Split a `data:<media-type>;base64,<data>` URL into its parts, or null if it is
 * not a base64 data URL. Pure. */
export function parseDataUrl(dataUrl: string): { mediaType: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl.trim())
  return m ? { mediaType: m[1], data: m[2] } : null
}

/** An Anthropic image content block from a data URL, or null if it can't parse. */
function imageBlock(screenshot: string): Record<string, unknown> | null {
  const img = parseDataUrl(screenshot)
  return img
    ? { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } }
    : null
}

/** The Anthropic Messages API request for a chat turn: the page URL/text is the
 * `system`, the whole thread is the `messages` array. When a screenshot is given,
 * it rides as an image block on the LAST (user) turn so the model can see the
 * page (e.g. a map). Pure. */
export function buildAnthropicChatRequest(
  config: LlmConfig,
  systemPrompt: string,
  messages: ChatMessage[],
  screenshot?: string
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  if (!config.apiKey || config.apiKey.trim() === '') {
    throw new Error('Anthropic API key is not set (Settings → AI)')
  }
  const img = screenshot ? imageBlock(screenshot) : null
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
      messages: messages.map((m, i) => {
        // Attach the screenshot to the last user turn (the current question).
        if (img && m.role === 'user' && i === messages.length - 1) {
          return { role: m.role, content: [img, { type: 'text', text: m.text }] }
        }
        return { role: m.role, content: m.text }
      })
    }
  }
}

/** Flatten a chat into a single prompt string for the CLI path (`claude -p` has
 * no separate roles): the page context, then the labelled transcript, ending on
 * an "Assistant:" cue so the model continues the last (user) turn. Pure. */
export function composeChatPrompt(systemPrompt: string, messages: ChatMessage[]): string {
  const transcript = messages
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text.trim()}`)
    .join('\n\n')
  return `${systemPrompt.trim()}\n\n---\n\n${transcript}\n\nAssistant:`
}

// --- CLI stream-json (image-capable) ------------------------------------------
// Plain `claude -p "<text>"` can't take an image. `claude -p --input-format
// stream-json` accepts a user message whose `content` is a block array — text +
// an image block, exactly like the API — so the CLI (the Claude subscription) can
// see a screenshot too. Used ONLY when a screenshot is attached; the text-only
// chat stays on the simpler plain-text path.

/** argv for the stream-json CLI call. --verbose is required by the CLI alongside
 * --output-format=stream-json. Pure. */
export function buildClaudeStreamArgs(config: LlmConfig): string[] {
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose'
  ]
  // Same clamp as the plain path (see buildClaudeCliArgs / chatClampArgs): no MCP,
  // web-lookup tools only.
  if (!config.loadMcp) args.push(...chatClampArgs())
  if (config.model && config.model.trim() !== '') args.push('--model', config.model.trim())
  return args
}

/** The single stdin line for the stream-json CLI call: one user message whose
 * content is the composed transcript plus the screenshot as an image block. The
 * whole conversation folds into this one text block (the input stream only takes
 * user messages, so assistant turns can't be replayed as roles). Pure. */
export function buildClaudeStreamInput(
  systemPrompt: string,
  messages: ChatMessage[],
  screenshot: string
): string {
  const text = composeChatPrompt(systemPrompt, messages)
  const img = imageBlock(screenshot)
  const content = img ? [img, { type: 'text', text }] : [{ type: 'text', text }]
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n'
}

/** Pull the answer out of the CLI's stream-json stdout: NDJSON where the final
 * `{"type":"result"}` line carries the text in `result`. Throws on an error
 * result or when no result line is present. Pure. */
export function parseClaudeStreamResult(stdout: string): string {
  type ResultLine = { type?: string; subtype?: string; is_error?: boolean; result?: string }
  let result: ResultLine | null = null
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const obj = JSON.parse(trimmed) as ResultLine
      if (obj.type === 'result') result = obj
    } catch {
      // Non-JSON lines (rare) are ignored — only the result line matters.
    }
  }
  if (!result) throw new Error('claude CLI returned no result')
  if (result.is_error || result.subtype !== 'success') {
    throw new Error(result.result?.trim() || 'claude CLI error')
  }
  const text = (result.result ?? '').trim()
  if (text === '') throw new Error('claude CLI returned no output')
  return text
}
