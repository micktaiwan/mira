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

/** Skills capability slice: the native edges run-skill needs. */
export interface SkillsContext {
  /** The active tab's url, or null when there is no web page (empty window /
   * Settings tab). Decides which skills apply. */
  activeUrl: () => string | null
  /** Pull the text a skill's source describes out of the active page. The DOM
   * edge (executeJavaScript in the WebContentsView). */
  extractText: (source: SkillSource) => Promise<string>
  /** The AI engine: turn extracted text into a result, given the skill's prompt.
   * Today a local extractive summary; an LLM swaps in here. */
  summarize: (prompt: string, text: string) => Promise<string>
}

export interface RunSkillParams {
  id: string
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
    // (Mickael: "l'ouverture dépend du type de skill"). Today only 'pane': it opens
    // the right pane, shows an hourglass, then the summary / error. Other sinks
    // (page write, external) will branch here later without opening the pane.
    const usePane = skill.sink.kind === 'pane'
    if (usePane) ctx.showSkillPane({ open: true, title: skill.name, status: 'loading' })
    try {
      const text = await ctx.extractText(skill.source)
      if (text.trim() === '') {
        const error = 'no page content to summarize'
        if (usePane) ctx.showSkillPane({ open: true, title: skill.name, status: 'error', error })
        return { ok: false, error }
      }
      const summary = await ctx.summarize(skill.prompt, text)
      if (usePane) {
        ctx.showSkillPane({ open: true, title: skill.name, status: 'done', text: summary })
      }
      return { ok: true, skill: skill.id, name: skill.name, sink: skill.sink.kind, summary }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (usePane) {
        ctx.showSkillPane({ open: true, title: skill.name, status: 'error', error: message })
      }
      return fail(error)
    }
  }
}
