// Skills domain: the registry surface of Mira's per-site capabilities. Two
// commands, both pilotable from IPC / socket / MCP like everything else:
//   - list-skills : which skills apply to the current page (feeds the palette's
//                   "Skills on this page" group and answers an agent's query).
//   - run-skill   : extract the page text a skill wants, run it through the AI
//                   engine with the skill's prompt, return the result.
//
// The pure resolution logic lives in ../skills.ts (resolveSkills, tested without
// Chromium). Here we only wire it to the native edges — reading the active tab's
// url, pulling its text, calling the engine — which are injected via the context
// so this stays testable with a fake (see skills.test.ts).

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'
import { resolveSkills, type SkillSource } from '../skills'
import type { ChatMessage, PageContext } from '../llm'

/** Skills capability slice: the native edges run-skill / run-prompt need. */
export interface SkillsContext {
  /** The active tab's url, or null when there is no web page (empty window /
   * Settings tab). Decides which skills apply. */
  activeUrl: () => string | null
  /** Pull the text a skill's source describes out of the active page. The DOM
   * edge (executeJavaScript in the WebContentsView). */
  extractText: (source: SkillSource) => Promise<string>
  /** The one-shot AI engine (a skill): turn extracted text into a result, given
   * the skill's prompt. Today a local extractive summary; an LLM swaps in here. */
  summarize: (prompt: string, text: string) => Promise<string>
  /** The multi-turn AI engine (the pane chat): answer the last turn given the
   * whole conversation and the current page (URL + text + optional screenshot). */
  chat: (messages: ChatMessage[], page: PageContext) => Promise<string>
  /** Screenshot the active page as a PNG data URL, or null when there is no live
   * page. The pixel edge behind the 📷 button; only called on explicit request. */
  capturePage: () => Promise<string | null>
}

export interface RunSkillParams {
  id: string
}

export interface RunPromptParams {
  prompt: string
  /** When true, attach a screenshot of the current page to this turn (📷 button),
   * so a vision model can see what the text can't (a map, a canvas). Off by
   * default — the image is NEVER sent automatically. */
  withScreenshot?: boolean
}

/** Cap the pane header derived from a free prompt so a long question doesn't
 * overflow the title row. */
function promptTitle(prompt: string): string {
  const t = prompt.trim()
  return t.length > 60 ? `${t.slice(0, 57)}…` : t
}

export const skillsCommands: CommandMap<CommandContext> = {
  'list-skills': (ctx) => {
    const url = ctx.activeUrl()
    const skills = resolveSkills(url ?? '')
    // Only the id + label cross the wire; the prompt/source/sink stay internal.
    return { ok: true, url, skills: skills.map((s) => ({ id: s.id, name: s.name })) }
  },

  'run-skill': async (ctx, params) => {
    const { id } = (params ?? {}) as Partial<RunSkillParams>
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: 'missing "id"' }
    }
    const url = ctx.activeUrl()
    // A skill can only run where it applies — resolve against the current page.
    const skill = resolveSkills(url ?? '').find((s) => s.id === id)
    if (!skill) return { ok: false, error: `skill not applicable here: ${id}` }
    // The sink decides where the result surfaces AND whether a surface opens at all
    // (Mickael: "l'ouverture dépend du type de skill"). Today only 'pane': it adds
    // a turn to the pane conversation (the skill name as the question, its summary
    // as the answer). Other sinks (page write, external) branch here later.
    const usePane = skill.sink.kind === 'pane'
    // Thread this run onto the existing conversation (a skill posts a Q/A pair);
    // the first entry sets the pane title.
    const pane = usePane ? ctx.getSkillPane() : null
    const title = pane?.title || skill.name
    const withUser: ChatMessage[] = pane
      ? [...pane.messages, { role: 'user', text: skill.name }]
      : []
    if (usePane) ctx.showSkillPane({ open: true, title, status: 'loading', messages: withUser })
    try {
      const text = await ctx.extractText(skill.source)
      if (text.trim() === '') {
        const error = 'no page content to summarize'
        if (usePane) {
          ctx.showSkillPane({ open: true, title, status: 'error', messages: withUser, error })
        }
        return { ok: false, error }
      }
      // A skill is one-shot: its own prompt + the page text, no chat history.
      const summary = await ctx.summarize(skill.prompt, text)
      if (usePane) {
        ctx.showSkillPane({
          open: true,
          title,
          status: 'idle',
          messages: [...withUser, { role: 'assistant', text: summary }]
        })
      }
      return { ok: true, skill: skill.id, name: skill.name, sink: skill.sink.kind, summary }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (usePane) {
        ctx.showSkillPane({
          open: true,
          title,
          status: 'error',
          messages: withUser,
          error: message
        })
      }
      return fail(error)
    }
  },

  // Free-form prompt from the pane's input: a chat turn. Append the question to the
  // conversation, answer it with the current page's text as context (best-effort —
  // a page that yields no text just becomes a plain question) AND the prior turns,
  // then append the answer.
  'run-prompt': async (ctx, params) => {
    const { prompt, withScreenshot } = (params ?? {}) as Partial<RunPromptParams>
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      return { ok: false, error: 'missing "prompt"' }
    }
    const pane = ctx.getSkillPane()
    // The first message sets the conversation title; later turns keep it.
    const title = pane.title || promptTitle(prompt)
    const withUser: ChatMessage[] = [...pane.messages, { role: 'user', text: prompt.trim() }]
    ctx.showSkillPane({ open: true, title, status: 'loading', messages: withUser })
    try {
      // Best-effort page context: no active web page (Settings / empty) is fine,
      // the prompt is then answered on its own. The URL is always included so the
      // assistant knows which page it is on (it can't infer it from the text).
      const url = ctx.activeUrl() ?? ''
      let text = ''
      try {
        text = await ctx.extractText({ kind: 'readability' })
      } catch {
        text = ''
      }
      // Only when the user asked (📷): capture a screenshot so a vision model can
      // see the page. Best-effort — a failed / empty capture just sends no image.
      let screenshot: string | undefined
      if (withScreenshot === true) {
        try {
          screenshot = (await ctx.capturePage()) ?? undefined
        } catch {
          screenshot = undefined
        }
      }
      // Send the whole thread (incl. this turn) so the model keeps context.
      const answer = await ctx.chat(withUser, { url, text, ...(screenshot ? { screenshot } : {}) })
      ctx.showSkillPane({
        open: true,
        title,
        status: 'idle',
        messages: [...withUser, { role: 'assistant', text: answer }]
      })
      return { ok: true, text: answer }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.showSkillPane({ open: true, title, status: 'error', messages: withUser, error: message })
      return fail(error)
    }
  }
}
