// Extension keyboard shortcuts (manifest `commands`), which the extensions lib
// only stubs (chrome.commands.getAll works, but nothing ever fires — the
// shortcuts are inert; extensions-plan.md §6). Claap binds Cmd+Shift+S to
// _execute_action (open its popup).
//
// Design:
//   - Shortcuts are read from the manifests of loaded extensions
//     (suggested_key.mac on macOS, falling back to `default` with Chrome's
//     documented Ctrl→Command conversion).
//   - Matching happens on 'before-input-event' of every webContents (tab views
//     AND the chrome — the shortcut must work while the address bar has
//     focus). This is deliberately NOT globalShortcut: chrome.commands is
//     browser-scoped, not system-global, and globalShortcut registers by
//     QWERTY key POSITION (the AZERTY trap of main-native-gotchas.md #4) while
//     input.key here is layout-aware.
//   - `_execute_action` clicks the extension's real toolbar button inside the
//     chrome's <browser-action-list> (open shadow root, buttons carry the
//     extension id) — same code path as a user click, popup anchored right.
//   - Named commands are delivered to chrome.commands.onCommand through the
//     lib's own event router (ExtensionsService.sendCommandEvent): listeners
//     registered by extension code live in the lib's event system, and its
//     router wakes a stopped service worker before sending.

import { app, webContents as allWebContents, type Session, type WebContents } from 'electron'

/** A parsed shortcut, in terms of Electron's before-input-event Input. */
export interface CommandShortcut {
  /** Uppercased input.key to match (letters/digits) or a named key ('F5',
   * 'ArrowUp', ','…). */
  key: string
  meta: boolean
  ctrl: boolean
  shift: boolean
  alt: boolean
}

/** One extension command with a usable shortcut. */
export interface ExtensionCommand {
  name: string
  shortcut: CommandShortcut
}

/** Manifest `commands` key names Chrome treats as "activate the action". */
const EXECUTE_ACTION_COMMANDS = new Set([
  '_execute_action',
  '_execute_browser_action',
  '_execute_page_action'
])

/** Is a command the "open the toolbar popup" pseudo-command? */
export function isExecuteActionCommand(name: string): boolean {
  return EXECUTE_ACTION_COMMANDS.has(name)
}

/** Manifest key name -> Electron input.key, for the non-letter keys Chrome
 * commands may use. Letters/digits pass through as themselves. */
const KEY_ALIASES: Record<string, string> = {
  comma: ',',
  period: '.',
  space: ' ',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  ins: 'Insert',
  insert: 'Insert',
  del: 'Delete',
  delete: 'Delete',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  tab: 'Tab'
}

/** Parse one manifest shortcut string ("Command+Shift+S", "Ctrl+Comma"…) into
 * a matcher. On macOS, Chrome converts a `Ctrl` modifier to Command (the real
 * Control key is spelled `MacCtrl`). Returns null for anything unusable
 * (media keys, missing key, unknown token). Pure. */
export function parseCommandShortcut(
  shortcut: string,
  platform: NodeJS.Platform
): CommandShortcut | null {
  if (typeof shortcut !== 'string' || !shortcut) return null
  const out = { key: '', meta: false, ctrl: false, shift: false, alt: false }
  for (const rawPart of shortcut.split('+')) {
    const part = rawPart.trim()
    const lower = part.toLowerCase()
    if (lower === 'command' || lower === 'cmd') out.meta = true
    else if (lower === 'macctrl') out.ctrl = true
    else if (lower === 'ctrl') {
      if (platform === 'darwin') out.meta = true
      else out.ctrl = true
    } else if (lower === 'alt' || lower === 'option') out.alt = true
    else if (lower === 'shift') out.shift = true
    else if (lower === 'search')
      return null // ChromeOS launcher key
    else if (lower.startsWith('media'))
      return null // media keys: not wired
    else if (out.key)
      return null // two non-modifier tokens
    else if (/^[a-z0-9]$/.test(lower)) out.key = part.toUpperCase()
    else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) out.key = part.toUpperCase()
    else if (KEY_ALIASES[lower]) out.key = KEY_ALIASES[lower]
    else return null
  }
  if (!out.key) return null
  return out
}

/** Just enough of a manifest to read commands. */
interface ManifestWithCommands {
  commands?: Record<string, { suggested_key?: Record<string, string> }>
}

/** The commands of a manifest that have a shortcut usable on `platform`. Pure. */
export function commandsFromManifest(
  manifest: unknown,
  platform: NodeJS.Platform
): ExtensionCommand[] {
  const commands = (manifest as ManifestWithCommands)?.commands
  if (!commands || typeof commands !== 'object') return []
  const platformKey =
    platform === 'darwin'
      ? 'mac'
      : platform === 'win32'
        ? 'windows'
        : platform === 'linux'
          ? 'linux'
          : platform
  const out: ExtensionCommand[] = []
  for (const [name, details] of Object.entries(commands)) {
    const keys = details?.suggested_key
    if (!keys || typeof keys !== 'object') continue
    const raw = keys[platformKey] ?? keys.default
    if (typeof raw !== 'string') continue
    const shortcut = parseCommandShortcut(raw, platform)
    if (shortcut) out.push({ name, shortcut })
  }
  return out
}

/** The subset of Electron's Input this matcher reads. */
export interface InputLike {
  type: string
  key: string
  control: boolean
  meta: boolean
  shift: boolean
  alt: boolean
}

/** Does a keyDown input match a shortcut? Modifiers must match exactly (a
 * Cmd+Shift+S binding must not also fire on Cmd+Alt+Shift+S); the key compares
 * case-insensitively so Shift-produced uppercase matches. Pure. */
export function inputMatches(shortcut: CommandShortcut, input: InputLike): boolean {
  if (input.type !== 'keyDown') return false
  if (
    input.meta !== shortcut.meta ||
    input.control !== shortcut.ctrl ||
    input.shift !== shortcut.shift ||
    input.alt !== shortcut.alt
  ) {
    return false
  }
  return input.key.length === 1
    ? input.key.toUpperCase() === shortcut.key.toUpperCase()
    : input.key === shortcut.key
}

/** Hooks one attached session gives the dispatcher. */
export interface CommandHooks {
  /** The chrome webContents of this profile's current window, or null. */
  chromeWebContents: () => WebContents | null
  /** Deliver a named command to chrome.commands.onCommand in the extension. */
  sendCommand: (extensionId: string, command: string) => void
}

export class ExtensionCommandsService {
  /** Commands per session per extension id, refreshed on load/unload. */
  private readonly bySession = new Map<Session, Map<string, ExtensionCommand[]>>()
  /** Dispatcher hooks per attached session. */
  private readonly hooks = new Map<Session, CommandHooks>()
  /** The app-level input hook is installed once. */
  private inputHooked = false

  /** Watch `ses`'s extensions and dispatch their shortcuts. Idempotent. */
  attach(ses: Session, hooks: CommandHooks): void {
    if (this.bySession.has(ses)) return
    const byExtension = new Map<string, ExtensionCommand[]>()
    this.bySession.set(ses, byExtension)
    this.hooks.set(ses, hooks)
    const refresh = (id: string, manifest: unknown): void => {
      const commands = commandsFromManifest(manifest, process.platform)
      if (commands.length) byExtension.set(id, commands)
      else byExtension.delete(id)
    }
    for (const ext of ses.extensions.getAllExtensions()) refresh(ext.id, ext.manifest)
    ses.extensions.on('extension-loaded', (_e, ext) => refresh(ext.id, ext.manifest))
    ses.extensions.on('extension-unloaded', (_e, ext) => byExtension.delete(ext.id))
    this.hookInput()
  }

  /** Listen on every webContents (present and future) — tabs, chrome, popups.
   * One listener per webContents; cheap (a map lookup per keyDown). */
  private hookInput(): void {
    if (this.inputHooked) return
    this.inputHooked = true
    const wire = (wc: WebContents): void => {
      wc.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return
        const hit = this.match(wc, input)
        if (!hit) return
        event.preventDefault()
        this.dispatch(hit.ses, hit.extensionId, hit.command)
      })
    }
    for (const wc of allWebContents.getAllWebContents()) wire(wc)
    app.on('web-contents-created', (_event, wc) => wire(wc))
  }

  /** The command matching `input` in the session owning `wc`, if any. A chrome
   * webContents runs on its own extension-free session, so it maps to the
   * profile session whose current window it belongs to. */
  private match(
    wc: WebContents,
    input: InputLike
  ): { ses: Session; extensionId: string; command: string } | null {
    const candidates: Session[] = []
    if (this.bySession.has(wc.session)) {
      candidates.push(wc.session)
    } else {
      for (const [ses, hooks] of this.hooks) {
        if (hooks.chromeWebContents() === wc) candidates.push(ses)
      }
    }
    for (const ses of candidates) {
      const byExtension = this.bySession.get(ses)
      if (!byExtension) continue
      for (const [extensionId, commands] of byExtension) {
        for (const command of commands) {
          if (inputMatches(command.shortcut, input)) {
            return { ses, extensionId, command: command.name }
          }
        }
      }
    }
    return null
  }

  /** Run one matched command. */
  private dispatch(ses: Session, extensionId: string, command: string): void {
    const hooks = this.hooks.get(ses)
    if (!hooks) return
    if (isExecuteActionCommand(command)) {
      this.clickAction(hooks.chromeWebContents(), extensionId)
      return
    }
    hooks.sendCommand(extensionId, command)
  }

  /** Open an extension's popup by clicking its real toolbar button in the
   * chrome renderer — the <browser-action-list> element's shadow root is open
   * and its buttons carry the extension id. Same code path as a user click, so
   * the popup anchors to the button. */
  private clickAction(chromeWc: WebContents | null, extensionId: string): void {
    if (!chromeWc || chromeWc.isDestroyed()) return
    const code = `(() => {
      const list = document.querySelector('browser-action-list');
      const button = list && list.shadowRoot && list.shadowRoot.getElementById(${JSON.stringify(extensionId)});
      if (!button) return false;
      button.click();
      return true;
    })()`
    chromeWc.executeJavaScript(code, true).then(
      (clicked) => {
        if (!clicked) {
          console.warn(`[mira-commands] no toolbar button found for ${extensionId}`)
        }
      },
      (error) => console.warn('[mira-commands] failed to activate action:', error)
    )
  }
}
