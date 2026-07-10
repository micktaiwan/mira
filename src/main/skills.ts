// Skills: contextual, per-site capabilities of Mira (summarize this page, reply,
// capitalize…). See skills-plan.md for the full design and CLAUDE.md for the two
// founding principles a skill obeys: it is a registry command (pilotable via
// IPC / socket / MCP) and its resolution logic is pure (unit-testable, no
// Chromium). This file holds ONLY that pure core — the abstraction, the built-in
// skills, and the two pure functions the commands lean on:
//   - resolveSkills(url)      : which skills apply to the current page,
//   - extractionScript(source): the JS a skill runs in the page to get its text,
//   - extractiveSummary(text) : the default, dependency-free "AI engine".
// The AI call and the DOM read are the native edges, injected via the command
// context (see commands/skills.ts), exactly like every other Electron-bound bit.

/** What a skill pulls out of the page to feed the engine. */
export type SkillSource =
  // Best-effort clean article text (main/article region, then body). A real
  // Readability pass can replace this later without changing the shape.
  | { kind: 'readability' }
  // The innerText of one specific element — for skills that target a precise
  // fragment (e.g. the open email in Gmail, a single LinkedIn thread).
  | { kind: 'selector'; selector: string }
  // The raw whole-page innerText (menus/footers included).
  | { kind: 'raw' }

/** Where a skill's result goes. V1 ships only the right pane; writing back into
 * the page (kind 'page') and external sinks (Panorama, files) are deferred — see
 * skills-plan.md §2/§6. */
export type SkillSink = { kind: 'pane' }

/** When a skill applies. An absent host means "any http(s) page" (a generic
 * skill like summarize-page); a host restricts it to that domain and its
 * subdomains. */
export interface SkillMatch {
  host?: string
}

/** A single contextual capability offered on a page. */
export interface Skill {
  /** Stable id (run-skill target, React key). */
  id: string
  /** Label shown in the palette's "Skills on this page" group. */
  name: string
  /** When this skill is offered. */
  match: SkillMatch
  /** System prompt handed to the AI engine (unused by the extractive default). */
  prompt: string
  /** What text to extract from the page. */
  source: SkillSource
  /** Where the result is shown. */
  sink: SkillSink
}

/** The built-in skills. Starts with one generic summarizer; per-site skills
 * (Gmail email, LinkedIn thread…) get added here as their DOM is verified. */
export const BUILTIN_SKILLS: readonly Skill[] = [
  {
    id: 'summarize-page',
    name: 'Summarize this page',
    match: {},
    prompt:
      'Summarize the following page content in a few clear, concise bullet points. ' +
      'Keep only what matters; drop navigation and boilerplate.',
    source: { kind: 'readability' },
    sink: { kind: 'pane' }
  }
]

/** The hostname of a page url, or null when it is not a real web page (Settings,
 * about:blank, empty address) — those get no skills. */
function hostOf(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.hostname
  } catch {
    return null
  }
}

/** Does a match apply to a hostname? No host → any page; otherwise the host or a
 * subdomain of it (mail.google.com matches host 'google.com' and 'mail.google.com'). */
function matchesHost(match: SkillMatch, host: string): boolean {
  if (!match.host) return true
  return host === match.host || host.endsWith('.' + match.host)
}

/** The skills applicable to a page url. Pure: same url → same list, no Electron.
 * Non-web urls (null host) get an empty list. */
export function resolveSkills(url: string, skills: readonly Skill[] = BUILTIN_SKILLS): Skill[] {
  const host = hostOf(url)
  if (host === null) return []
  return skills.filter((s) => matchesHost(s.match, host))
}

/** The JavaScript a skill's source runs in the page to return its text. Pure (a
 * string builder), so the extraction contract is unit-tested; only running it in
 * the WebContentsView is the native edge. Always returns a self-invoking
 * expression that evaluates to a string. */
export function extractionScript(source: SkillSource): string {
  if (source.kind === 'selector') {
    const sel = JSON.stringify(source.selector)
    return `(() => { const el = document.querySelector(${sel}); return el ? (el.innerText || el.textContent || '') : ''; })()`
  }
  if (source.kind === 'readability') {
    // Best-effort main-content region, falling back to the body.
    return `(() => { const el = document.querySelector('article, main, [role="main"]') || document.body; return el ? (el.innerText || '') : ''; })()`
  }
  return `(() => document.body ? document.body.innerText : '')()`
}

/** The default, dependency-free AI engine: a lead-sentence extractive summary.
 * It is not an LLM — it returns the opening sentences up to a char budget, which
 * is a real (if basic) summary and lets the whole pipeline work with zero setup.
 * An API/local model plugs in at the `summarize` context method without touching
 * this or run-skill. Pure and tested. */
export function extractiveSummary(text: string, maxChars = 600): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= maxChars) return clean
  const sentences = clean.match(/[^.!?]+[.!?]+/g)
  if (!sentences) return clean.slice(0, maxChars).trim()
  let out = ''
  for (const s of sentences) {
    if (out && (out + s).length > maxChars) break
    out += s
  }
  return (out.trim() || clean.slice(0, maxChars)).trim()
}
