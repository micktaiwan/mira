// The LLM engine behind the skill summary (run-skill) and the page chat
// (run-prompt), split out of the ProfileManager god object. It owns NO
// window/profile state: it only DISPATCHES a request to one of three providers —
// the offline 'extractive' summarizer, the Anthropic HTTP API, or the local
// `claude` CLI — using the pure request builders in ./llm.
//
// The two native edges (spawning the `claude` subprocess) are injected via
// LlmRunnerDeps so the provider dispatch is unit-testable without a real binary
// (see llm-runner.test.ts); profiles.ts constructs the runner with the real
// spawners (the module-level spawnClaudeCli / spawnClaudeCliStream defaults).

import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import {
  buildAnthropicRequest,
  buildAnthropicChatRequest,
  parseAnthropicResponse,
  claudeBinCandidates,
  claudeSpawnPath,
  buildClaudeCliArgs,
  buildClaudeStreamArgs,
  buildClaudeStreamInput,
  parseClaudeStreamResult,
  composePrompt,
  composeChatPrompt,
  chatSystemPrompt,
  type LlmConfig,
  type ChatMessage,
  type PageContext
} from './llm'
import { extractiveSummary } from './skills'

/** The injectable edges of the runner. The two `claude` spawners are swapped for
 * fakes in tests so the dispatch logic runs without a real binary; `fetchFn` is
 * the HTTP transport for the anthropic-api provider (defaults to global fetch). */
export interface LlmRunnerDeps {
  runClaudeCli: (config: LlmConfig, fullPrompt: string) => Promise<string>
  runClaudeCliStream: (config: LlmConfig, streamInput: string) => Promise<string>
  fetchFn: typeof fetch
}

export class LlmRunner {
  private readonly deps: LlmRunnerDeps

  constructor(deps?: Partial<LlmRunnerDeps>) {
    this.deps = {
      runClaudeCli: spawnClaudeCli,
      runClaudeCliStream: spawnClaudeCliStream,
      fetchFn: (...args: Parameters<typeof fetch>) => fetch(...args),
      ...deps
    }
  }

  /** One-shot summary (a skill prompt + the page text). 'extractive' has no model,
   * so it returns a lead-sentence summary of the text; 'anthropic-api' hits the
   * Messages API; 'claude-cli' feeds the composed prompt to `claude -p` on stdin. */
  async run(config: LlmConfig, prompt: string, text: string): Promise<string> {
    if (config.provider === 'extractive') return extractiveSummary(text)
    if (config.provider === 'anthropic-api') {
      const req = buildAnthropicRequest(config, prompt, text)
      const res = await this.deps.fetchFn(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body)
      })
      return parseAnthropicResponse(await res.json())
    }
    // 'claude-cli': feed the composed prompt on stdin, read the answer from stdout.
    return this.deps.runClaudeCli(config, composePrompt(prompt, text))
  }

  /** The chat engine (run-prompt): answer the last turn given the whole thread and
   * the page's text as context. Same three providers as run(), but multi-turn.
   * 'extractive' has no conversational model, so it falls back to a lead-sentence
   * summary of the page (ignoring the question), or echoes the last question when
   * there is no page. A turn WITH a screenshot goes through the CLI stream-json
   * path (which accepts an image block); a text-only turn stays on the plain path. */
  async chat(config: LlmConfig, messages: ChatMessage[], page: PageContext): Promise<string> {
    const system = chatSystemPrompt(page.url, page.text)
    if (config.provider === 'extractive') {
      const last = messages[messages.length - 1]?.text ?? ''
      return extractiveSummary(page.text.trim() !== '' ? page.text : last)
    }
    if (config.provider === 'anthropic-api') {
      const req = buildAnthropicChatRequest(config, system, messages, page.screenshot)
      const res = await this.deps.fetchFn(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body)
      })
      return parseAnthropicResponse(await res.json())
    }
    // 'claude-cli'. Plain -p can't take an image, so a turn WITH a screenshot goes
    // through the stream-json path; a text-only turn stays on the simpler path.
    if (page.screenshot) {
      return this.deps.runClaudeCliStream(
        config,
        buildClaudeStreamInput(system, messages, page.screenshot)
      )
    }
    return this.deps.runClaudeCli(config, composeChatPrompt(system, messages))
  }
}

/** Resolve the absolute path to the `claude` binary once (memoized). A packaged /
 * GUI-launched Mira does not inherit the shell PATH, so a bare `spawn('claude')`
 * would ENOENT; we probe the known install locations and use the first that
 * exists, falling back to the bare name (PATH) when none are found. Native edge
 * (fs) over the pure candidate list; the ordering is unit-tested in llm.test. */
let cachedClaudeBin: string | undefined
function resolveClaudeBin(): string {
  if (cachedClaudeBin) return cachedClaudeBin
  const candidates = claudeBinCandidates(process.env, homedir())
  const found = candidates.find((c) => c === 'claude' || existsSync(c))
  cachedClaudeBin = found ?? 'claude'
  return cachedClaudeBin
}

/** The env for the `claude` subprocess, with PATH enriched so a GUI-launched Mira
 * (which inherits a minimal PATH) can still resolve the binary and anything it
 * shells out to. Native edge over the pure claudeSpawnPath. */
function claudeSpawnEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: claudeSpawnPath(process.env, homedir()) }
}

/** Spawn `claude -p` and resolve its stdout. Uses the logged-in Claude Code
 * subscription (no API key). The binary is resolved via resolveClaudeBin so it
 * works even when the process PATH lacks the install dir (packaged / GUI launch).
 * The thin native edge of the runner; not unit-tested (a fake is injected). */
export function spawnClaudeCli(config: LlmConfig, fullPrompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveClaudeBin(), buildClaudeCliArgs(config), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: claudeSpawnEnv()
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += String(d)))
    child.stderr.on('data', (d) => (err += String(d)))
    child.on('error', (e) =>
      reject(new Error(`claude CLI not runnable: ${e.message} (is it installed / on PATH?)`))
    )
    child.on('close', (code) => {
      if (code === 0) {
        const text = out.trim()
        if (text === '') reject(new Error('claude CLI returned no output'))
        else resolve(text)
      } else {
        reject(new Error(err.trim() || `claude CLI exited with code ${code}`))
      }
    })
    child.stdin.write(fullPrompt)
    child.stdin.end()
  })
}

/** Spawn `claude -p --input-format stream-json` (image-capable) and resolve the
 * assistant text from its NDJSON stdout. Same subscription/PATH story as
 * spawnClaudeCli; used only when a screenshot is attached. Thin native edge. */
export function spawnClaudeCliStream(config: LlmConfig, streamInput: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveClaudeBin(), buildClaudeStreamArgs(config), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: claudeSpawnEnv()
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += String(d)))
    child.stderr.on('data', (d) => (err += String(d)))
    child.on('error', (e) =>
      reject(new Error(`claude CLI not runnable: ${e.message} (is it installed / on PATH?)`))
    )
    child.on('close', (code) => {
      // Even on exit 0 the answer lives in the NDJSON result line; on non-zero,
      // prefer stderr, else let the parser surface the stream's error result.
      if (code !== 0 && err.trim() !== '') {
        reject(new Error(err.trim()))
        return
      }
      try {
        resolve(parseClaudeStreamResult(out))
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
    child.stdin.write(streamInput)
    child.stdin.end()
  })
}
