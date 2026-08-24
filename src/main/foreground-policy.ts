// Who is allowed to pull Mira in front of whatever the user is doing.
//
// The rule, in one line: a command that came from OUTSIDE (socket / MCP / an
// agent script) never foregrounds the app; a command the user drove from Mira's
// own UI does, exactly as before.
//
// Why: Mira is scripted continuously by Claude sessions (open a page, read it,
// screenshot it). Every one of those `new-tab` / `open-url` / `activate-tab`
// calls used to end in `window.show() + window.focus()`, which on macOS is an
// app activation — the browser jumped in front of the editor mid-sentence. The
// background-reload guard (mac-activation.ts) already stopped Chromium from
// doing it on its own; this stops US from doing it deliberately.
//
// A script that genuinely WANTS Mira in front still has a way: the explicit
// `focus-app` command (and `focus:true` where a command accepts it). The point
// is that it must be asked for, never a side effect of automating a page.

/** Where a command came from. `ui` = Mira's own chrome (IPC), a menu item or a
 * keyboard shortcut — the user is already looking at Mira. `external` = the
 * unix socket, the MCP server, an agent: the user is looking at something else. */
export type CommandOrigin = 'ui' | 'external'

/** Whether a command from `origin` may raise/activate the app.
 *
 * `explicit` is an opt-in the caller passed on the command itself (e.g. a
 * hypothetical `focus:true`); when present it always wins, in both directions —
 * a UI caller can ask NOT to steal focus just as a script can ask to. */
export function mayForeground(origin: CommandOrigin, explicit?: boolean): boolean {
  if (typeof explicit === 'boolean') return explicit
  return origin === 'ui'
}
