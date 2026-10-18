# Per-profile settings — discussion (NOTHING IS DECIDED)

**Status: open. No decision made. No code written on this topic.**
This file only **records** a discussion so it does not get lost again. It does not
describe a launched workstream or a chosen direction. As long as this line is here, we do
nothing.

## The question asked

Are Mira's settings per profile today? And if we made them per profile, what would the
impacts be?

## Current state (VERIFIED in the code, 2026-07-10)

Settings are **100 % global**, shared by all profiles:

- A single file `userData/settings.json`, loaded/written in `index.ts:123-137`.
- A single copy `this.appSettings` in the `ProfileManager` (`profiles.ts:181`),
  used by every window.
- `getSettings` / `setHomeUrl` **ignore** the `target` (the profile window) and
  read/write the singleton (`profiles.ts:1056-1061`).
- There is only **one setting** today: `homeUrl` (URL opened by a new tab / a fresh
  window). Since 2026-07-10, an empty value = blank tab (`about:blank`, empty address
  bar).

## What would make the per-profile switch cheap

1. **The command context already knows the profile.** `makeContext(target)`
   receives the targeted window; `getSettings`/`setHomeUrl` could address the
   right profile without new routing plumbing. Since the Settings surface is a tab
   _inside_ a profile window, "which profile are we editing?" has a natural answer:
   the window's one.
2. **The per-profile persistence pattern already exists.** `sessions.json` is a
   `Record<profileId, …>` (`session-store.ts`). We would copy that model — no new
   convention to invent.

## Concrete impacts if we did it

- `settings-store.ts`: add a **map** normalizer `Record<profileId,
AppSettings>` (like `normalizeSessions`); define the default for a profile with no
  entry.
- Storage (`index.ts`): `settings.json` becomes a map by id. **Migration**
  of the current flat file `{homeUrl}` (apply it to `default`? to all?) otherwise
  we lose the existing setting.
- `ProfileManager`: `this.appSettings` (one value) becomes a
  `Map<profileId, AppSettings>`. The `homeUrl` constructor dep becomes a per-profile
  seed or a fallback default.
- The 3 home reads (`profiles.ts` ~335, ~773, ~1071):
  `this.appSettings.homeUrl` → `homeFor(pw.id)`. It is the functional core: a
  new tab opens the home **of its profile**.
- `getSettings`/`setHomeUrl`: address `target.id`.
- Fresh window / restore: home of the profile concerned.
- Tests + `fake-context`: `state.homeUrl` (string) → `state.homeUrl[profileId]`.

Real but **bounded** blast radius: a single functional setting not to break.

## The real design trap (to settle before coding)

The question is not "per profile: yes/no", it is **"are all settings per-profile?"**.
`homeUrl` is meaningfully per-profile (work profile → work home). But a future setting (UI
theme, default search engine) would rather be **app-wide**. Making everything per-profile =
risk of duplicating a global setting in every profile (two sources of truth that diverge)
or of re-splitting later. The clean model would be **two buckets**: `AppSettings`
(global) + `ProfileSettings` (per id).

## Unsettled open question (UI)

When Settings is opened in profile A's window: edit **A only** (implicit, simple) or
see/edit **all profiles** from a single screen? That changes the UI of the General
section, not the back end.

## Decision

**None.** The user has not decided. We code nothing for now. This file and its track line
exist only to find the analysis again the day the decision is made.
