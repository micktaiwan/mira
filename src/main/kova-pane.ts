// The right-side AI pane as a TERMINAL: when Kova's library is linked into Mira
// (native/mira-kova, optional), the pane hosts a real Kova terminal running an
// interactive `claude` session instead of the `claude -p` chat. This file holds
// the PURE decisions (when the terminal mode is on, what command the pane runs,
// what a skill types into it, when the native view is shown, the rect it takes),
// unit-tested in kova-pane.test.ts. The native edge is mac-kova.ts (loader) and
// the wiring lives in profiles.ts.

import type { LlmProvider } from './llm'

/** A rectangle in window-content coordinates, top-left origin, in points (the
 * DOM's getBoundingClientRect space, which is also Electron's content space). */
export interface TerminalRect {
  x: number
  y: number
  width: number
  height: number
}

/** The terminal replaces the chat only when Kova's library is available AND the
 * user's engine is the Claude CLI: the API and offline providers are a deliberate
 * choice of something else than Claude Code, so they keep the chat. */
export function terminalModeOn(input: { addonAvailable: boolean; provider: LlmProvider }): boolean {
  return input.addonAvailable && input.provider === 'claude-cli'
}

/** What the embedded `claude` is told about where it runs. The page context the
 * chat used to inject is replaced by the `mira` CLI: Claude reads the page
 * itself, on demand (MIRA_NO_SESSION_WINDOW=1, set in the pane's env, makes the
 * CLI target the active tab of the focused Mira window instead of a separate
 * per-session window). */
export const TERMINAL_SYSTEM_PROMPT = [
  'You are running inside the right-side panel of Mira, the web browser of the user.',
  'The user is looking at a web page in the same Mira window.',
  'Read that page with the mira CLI before answering about it:',
  '`mira tabs` lists the tabs (the active one is marked *),',
  '`mira exec "document.body.innerText"` returns the text of the active tab,',
  '`mira snap` returns what the page lets you do plus its visible text,',
  'and `mira shot` takes a screenshot when you need to see it.'
].join(' ')

/** Quote one shell word for a POSIX shell (zsh/bash): single quotes, with each
 * embedded single quote closed, escaped, and reopened. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`
}

/** The per-session markers a parent Claude Code session leaves in Mira's
 * environment (a Mira started from a Claude session), as read from a session's
 * env: unset so the embedded claude is a session of its own, not a child one.
 * CLAUDE_CODE_CHILD_SESSION is the one that bites: inherited, it turns the
 * embedded session's transcript saving off, so it can neither be resumed nor
 * read back. The user-level settings (CLAUDE_EFFORT, CLAUDE_CODE_PLUGIN_DIRS,
 * CLAUDE_CODE_NO_FLICKER…) are kept on purpose. */
export const PARENT_CLAUDE_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_PID'
]

/** The command line typed into the pane's login shell, and the extra env. `exec`
 * replaces the shell with `claude`: when the user quits Claude Code, the shell
 * is gone too and the pane reports EXITED, instead of leaving a bare shell where
 * a skill's text would later run as a command; `|| exit` covers an exec that
 * failed (claude not found), which an interactive shell survives. An initial
 * prompt (a skill run while no session exists yet) is passed as claude's first
 * message, through terminalText: the line is typed into the shell's line
 * editor, where a newline runs a second command and a control character edits
 * or accepts the line, so neither may reach it. */
export function buildClaudeLaunch(
  initialPrompt?: string,
  hostEnv: Record<string, string | undefined> = {}
): { command: string; env: string[] } {
  const parts = ['exec', 'claude', '--append-system-prompt', shellQuote(TERMINAL_SYSTEM_PROMPT)]
  const first = initialPrompt === undefined ? '' : firstMessage(initialPrompt)
  if (first !== '') parts.push(shellQuote(first))
  const command = `unset ${PARENT_CLAUDE_VARS.join(' ')}; ${parts.join(' ')} || exit`
  return { command, env: ['MIRA_NO_SESSION_WINDOW=1', ...localeEnv(hostEnv)] }
}

/** The characters that make claude's first message something else than a
 * message: `-` would be read as a CLI option (`--dangerously-skip-permissions`),
 * `/` runs a slash command, `!` a bash command, `#` writes memory. */
const NOT_A_MESSAGE = /^[-/!#]/

/** claude's first message, safe as a positional argument: terminalText, then a
 * neutral prefix when it would otherwise start like an option or a command. */
export function firstMessage(text: string): string {
  const clean = terminalText(text)
  return NOT_A_MESSAGE.test(clean) ? `Prompt: ${clean}` : clean
}

/** A Mira launched from the Dock inherits no locale (launchd sets none), and a
 * line editor in the C locale can read UTF-8 bytes as Meta+key edits. Give the
 * pane a UTF-8 locale, only when the host has none of its own. */
export function localeEnv(hostEnv: Record<string, string | undefined>): string[] {
  const has = (k: string): boolean => (hostEnv[k] ?? '').trim() !== ''
  return has('LANG') || has('LC_ALL') || has('LC_CTYPE') ? [] : ['LANG=en_US.UTF-8']
}

/** Text safe to type into the terminal: one line, every control character
 * (C0, DEL, C1: newline, Ctrl+U, Ctrl+O, ESC…) and whitespace run turned into a
 * single space. Used for what reaches the shell AND what is pasted into claude:
 * no newline or control key ever travels with the text. How Claude Code's
 * permission menu reacts to pasted printable text is not measured. */
export function terminalText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim()
}

/** What a skill types into the terminal: its name and its prompt, on one line,
 * telling Claude to read the page first (the chat path extracted the text for it). */
export function skillTerminalPrompt(skill: { name: string; prompt: string }): string {
  return terminalText(
    `${skill.name}: ${skill.prompt} Read the current page with the mira CLI first.`
  )
}

/** Whether the native terminal view is visible. It sits ABOVE the chrome DOM, so
 * it must hide whenever the chrome draws something over the pane's area: the
 * palette and the media gallery are full-window DOM overlays. No rect yet (the
 * chrome has not measured the pane) also hides it. */
export function terminalShown(input: {
  paneOpen: boolean
  paletteOpen: boolean
  mediaGalleryOpen: boolean
  rect: TerminalRect | null
}): boolean {
  if (!input.paneOpen || input.paletteOpen || input.mediaGalleryOpen) return false
  return input.rect !== null && input.rect.width >= 1 && input.rect.height >= 1
}

/** Validate a rect sent by the chrome (set-terminal-rect). null = "no terminal
 * area" (the pane unmounted). Returns undefined when the input is malformed. */
export function parseTerminalRect(value: unknown): TerminalRect | null | undefined {
  if (value === null) return null
  if (typeof value !== 'object') return undefined
  const r = value as Record<string, unknown>
  const nums = [r.x, r.y, r.width, r.height]
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined
  const [x, y, width, height] = nums as number[]
  if (width < 0 || height < 0) return undefined
  return { x, y, width, height }
}
