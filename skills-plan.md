# Plan — Contextual per-site skills (`skills`)

Set on 2026-07-10 (formerly `actions-plan.md`, renamed "skills" on 2026-07-10). Starting
spec: the concept is settled, the implementation is still to do. The general architecture
and the two founding principles live in `CLAUDE.md`; progress will live in `track.md`.
This doc carries the plan + the **open questions** (marked ❓) to settle as we go.
Deliberate approach: we **create the first skill** and refine the model as we move
forward — several points below will only be settled on contact with the code.

> **Disambiguation.** Here, a "skill" = a **Mira capability on a given site**
> (summarize this conversation, reply, save to notes…). It is distinct from **Claude's
> skills** (the harness's `/skills`). Since Mira can be driven by Claude via MCP, the risk
> of a vocabulary collision exists: when a Mira skill shows up on the socket / MCP, name it
> unambiguously (prefix `skill:` / commands `list-skills`, `run-skill`).

## 1. The concept

A **skill** is a **contextual capability driven by a per-site config**.

On the current page, Mira reads the content, looks at which site it is, and offers the
**set of skills defined for that site**. Each skill has its own **system prompt** and its
own behavior.

Canonical example — I am on LinkedIn in a conversation. The site's skills:

- **Summarize the conversation** → text displayed (in a right-hand pane, see §2).
- **Reply automatically** → generates a reply (V2: injects it back into the compose box;
  V1: displayed, I copy-paste).
- **Save to my notes** → sends the content to an external notes system (a file, a notes
  app, or a Claude skill).

**Where it surfaces — in the Cmd+K palette.** [DECIDED 2026-07-10] The skills that apply
to the active site appear as **dynamic palette entries**, under a **"Skills on this page"**
group — exactly the `buildPaletteEntries` mechanism already in place (see
`src/main/palette.ts`). No separate entry surface: the palette is already the action hub,
skills are one more source for it. `list-skills` (see §3) feeds these entries; picking an
entry launches `run-skill`.

The point of a native feature (vs a Chrome extension): it fits the **two founding
principles** of Mira. A skill = a registry command, so **drivable** (socket + MCP → an
agent can launch a skill on my page from a conversation) and **testable** (the site→skills
resolution logic is a Vitest test, without launching Chromium). Decision made on
2026-07-10: we do the native version in Mira first, not an extension. Portability to other
browsers is not a goal.

## 2. The central abstraction: a skill

A site's config = a **list of skills**. A skill is described by:

| Field    | Role                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------- |
| `name`   | Label shown in the palette ("Skills on this page")                                                |
| `match`  | When the skill applies (domain, URL pattern, possibly a selector — see ❓ extraction)             |
| `prompt` | The skill's own system prompt                                                                     |
| `source` | What we extract from the page and give to the AI (see §4)                                         |
| `sink`   | Where the result goes (see below)                                                                 |

### The destination (`sink`) — depends on the skill

The result does **not always go to the same place**: the skill decides. Three families,
of increasing difficulty — this is the core of the V1/V2 split:

1. **Right-hand pane** — e.g. summarize the conversation → an AI text is displayed in a
   **right side panel** of Mira. **New chrome surface.** Key point (pitfall #3 of
   `CLAUDE.md`): this pane **shrinks the web view** (we reduce the width of the
   `WebContentsView`, the way the sidebar shifts it on the left), so it does **not
   overflow** on top of the page → no native layer above it, not the overlay problem.
   **V1 scope** (it is the default display surface). _(surface to build)_
2. **On the page itself** — e.g. auto-reply that writes into the compose box, or
   annotate/highlight. It is a **DOM write** in the `WebContentsView`. **Fragile**
   (depends on the site's HTML, breaks when the site changes). **Deferred to V2** (see §6).
3. **External output** — e.g. save to notes → writes a file / calls an external notes
   app / triggers a Claude skill. The skill hits a tool **outside Mira** (socket, MCP,
   script). ❓ in V1 scope? (see Open questions)

### Async — an hourglass in the surface concerned

`run-skill` calls an AI: it is **slow** (network + model), unlike all the current,
near-instant commands. The "it's working" visual feedback lives **in the sink's surface**,
and so depends on the skill: an **hourglass / spinner** in the right-hand pane for a
summary, or an indicator in the UI for a skill that writes on the page. Exact model
(token-by-token streaming? cancellation? error state?): **to dig into at the first
skill.** ❓

## 3. Registry surface (the "everything drivable")

Two commands in the registry (domain `commands/skills.ts`, modeled on
`commands/tabs.ts` / `commands/palette.ts`):

- **`list-skills`** — for the current page/site, returns the applicable skills
  (`{ name, ... }`). Feeds the palette's "Skills on this page" entries _and_ can be queried
  over the socket/MCP.
- **`run-skill`** — runs a named skill: extracts the source, calls the AI with the prompt,
  applies the `sink`. Async (see §2).

Direct consequence: from a Claude conversation (via MCP, wrapper of the socket), I can
list and launch a skill on the page open in Mira.

The **pure, testable** logic to isolate (a Vitest test, no Chromium): the **resolution**
`(url, conf) → list of applicable skills`. The AI call and the DOM are the edges not
unit-tested (like the native Electron bits elsewhere).

## 4. Content extraction

By default, extract the page's **clean text**, not `document.body.innerText` (polluted by
menus/ads/footers). State of the art: **Readability.js** (the lib behind Firefox's reader
mode) injected into the `WebContentsView`, result sent back over IPC.

But the LinkedIn example shows the need to target a **precise piece** (just the
conversation thread, not the whole page). Hence the open question on the granularity of
the source per skill (❓ §Open questions).

## 5. The AI engine

❓ **Remote API vs local — not settled.** Two paths:

- **API** (Claude / OpenAI): max quality, key stored on the main process side (Node, not
  the MV3 constraints), calls without CORS. Costs money, and the content goes to a third
  party.
- **Local** (Ollama on `localhost`): free, private, but lower quality and depends on the
  Mac being on.

Default lead to confirm: start with the **API, key in local config**, add local later if
usage follows. To settle at implementation time.

## 6. Deferred to V2 — HTML injection into the page

The "auto-reply that writes directly into the LinkedIn compose box" case. Out of V1 scope
(display in the right pane only). It is the fragile piece: writing into the DOM of a
third-party site depends on its HTML (selectors that break, contenteditable/React fields
that do not accept a plain `.value =`, synthetic events to dispatch so the site records the
input). To be specified properly when we tackle it — do not improvise it in V1.

## 7. Open questions (to settle, often at the first skill)

- ❓ **Extraction granularity.** Do all skills read the same thing (the whole Readability
  article), or can a skill target a **precise piece** of the page via a selector (the
  LinkedIn conversation thread)? Determines whether `source` carries a selector.

- ❓ **Precise async model.** Token-by-token streaming in the pane, or one-shot display at
  the end? Cancellation? Error state? To dig into at the first skill.

- ❓ **Editing the per-site config — "smart UI".** A UI to define/edit a site's skills,
  not just a hand-written JSON. Shape to design later. Sub-questions: where the config
  lives (a file like `~/.mira/skills.json`? per profile?), how it is edited (Settings?
  selector capture by pointing at the element?), global default skills + per-site
  overrides.

- ❓ **External output in V1?** Does the "save to notes" skill (external sink) make it into
  the first cut, or is V1 = right pane + the external one comes right after?

- ❓ **AI engine**: API vs local first (see §5).

## 8. V1 scope (proposed)

- Current site's skills listed as **"Skills on this page"** entries in the Cmd+K palette
  (`list-skills`).
- `run-skill` with **sink = right-hand pane** (new chrome surface that shrinks the web
  view), hourglass during the call.
- Readability extraction by default.
- A minimal per-site config (shape to decide — the smart UI is deferred).
- AI engine wired to an API with a local key (to confirm).
- **We code a first concrete skill (e.g. summarize a conversation) end to end**, and let
  the model settle from that real case.

HTML injection (§6), smart editing UI (§7) and external output explicitly out of V1
(unless decided otherwise).

## 9. Switch on 2026-07-11 — the heavy agent lives OUTSIDE Mira (option A)

Discussion settled on 2026-07-11: the real need (on a third-party web app page, analyze who
is writing, enrich via the web + an external MCP, draft a contextualized reply) is a
**multi-step tooled agent**, not the one-shot skill of this plan. Decision: **we do not
build that agent engine inside Mira.** The agent is **Claude Code** running in the terminal
(Kova); it drives Mira **from outside** through the socket (`exec-js` + registry). It is the
direct payoff of the "everything drivable" founding principle.

Consequences for this plan:

- The internal LLM engine (pane, `claude-cli` provider, Agent toggle) stays **useful for
  quick Q&A on the page**, but **stops being the target for agentic work**. Do not invest
  in turning it into a multi-tool agent: that role moves outside.
- Mira's built-in skills stay **light** (summary, translation… one LLM call), and Mira
  keeps its role as a **drivable browser**. The ambition goes up a notch **in the Claude
  Code skills**, not in the browser.
- **Order A → B.** **A** = Claude Code skill → Mira through the socket, testable **without
  a single line of Mira code**. **B** (later) = launch a skill from the Cmd+K palette, where
  Mira spawns a Kova pane that launches Claude Code, which drives Mira back.
- **Mira MCP** = an ergonomic wrapper on top of the socket, **not a prerequisite** (the
  socket is enough to test everything).
- **First concrete test: a Claude Code "inbox triage" skill** (open the web app, wait for
  it to load, read the first message, decide whether it deserves a reply). ⚠️ The target
  is not a plain page: it is an **extension** **+** a **web app** coupled by a content
  script — the agent drives the web app, not just a static DOM.

Living state + next action in `track.md` ("Agent outside Mira" line).
