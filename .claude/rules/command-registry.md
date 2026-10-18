---
paths:
  - 'src/main/commands/**'
---

# Command registry — split to avoid collisions

Mira is vibe coded across **several sessions in parallel**. One file edited
by two sessions = a merge conflict or an overwrite. So the split aims at **one
file per feature**. Since everything is a command, a naive layout would
concentrate every feature in a single file — exactly the collision point to
avoid.

**Command registry = one file per domain.** The registry does NOT live in a single file. It is split across `src/main/commands/`:

```
src/main/commands/
  registry.ts     core types + generic buildRegistry (rarely changes)
  context.ts      CommandContext = intersection of each domain's slices
  index.ts        composition root + barrel: merges the maps, re-exports the public API
  navigation.ts   navigate/back/forward commands  + NavContext slice
  profiles.ts     open/create/rename/list commands + ProfileContext slice
  settings.ts     open-settings command           + SettingsContext slice
  <domain>.ts     … one file per domain
  *.test.ts       one test per domain; shared fake context in fake-context.ts
```

Split rules every session must follow:

1. **Adding a command to an existing domain** → edit **only** its domain file (e.g. `navigation.ts`). Do not pull logic back into `index.ts`.
2. **Adding a context capability** (a method the command needs) → add it to the **domain's slice** (`NavContext`, `ProfileContext`, …), not to a giant shared interface. The `makeContext` in `src/main/profiles.ts` (ProfileManager) then implements it.
3. **Adding a whole domain** → create `commands/<domain>.ts` (+ its slice + its `.test.ts`), then touch **a single** shared line: the `import` + the spread in `commands/index.ts`.
4. **Never re-import by internal path.** Consumers import from `./commands` (resolves to `commands/index.ts`), never `./commands/navigation` directly.
5. **The same principle applies to the other surfaces** as they grow: CSS per surface (`assets/toolbar.css`, `sidebar.css`, `palette.css`), React components per feature under `renderer/src/features/<x>/`, `App.tsx` only assembles them. Avoid piling into `main.css` or `App.tsx`.

Test before writing: "does my feature touch a file another session is probably
touching too?". If yes, that is a signal it needs a new domain file rather than
an append to a shared file.

**One feature = one test.** Every registry command has its unit test
(inputs → effect/returned value), run with `npm test` (Vitest). If a command is
too coupled to Electron to be tested simply, extract its pure logic into a
separate (testable) function and leave only the native call in the command
(thin, untested).
