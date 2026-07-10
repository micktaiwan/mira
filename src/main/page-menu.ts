// The right-click menu shown over web page content. Per CLAUDE.md "les deux
// pièges" #3, a menu drawn over the WebContentsView must be a NATIVE menu (a CSS
// popover would be hidden behind that native layer). So the popup itself is thin
// and native (in profiles.ts); the decision of WHICH items to show for a given
// right-click — a link? a text selection? an editable field? — is this pure,
// testable function.
//
// Mira actions (back / forward / reload / open-in-new-tab) are emitted as
// `command` items so they route through the same registry bus as the toolbar and
// the socket (the "tout pilotable" principle). Clipboard actions have no registry
// command and are emitted as native `role` items acting on the focused view.

/** What the right-click landed on, distilled from Electron's ContextMenuParams
 * plus the target view's history state. */
export interface PageContext {
  /** The href of a right-clicked link, or '' when not on a link. */
  linkURL: string
  /** The currently selected text, or '' when nothing is selected. */
  selectionText: string
  /** Whether the right-click was inside an editable field (input / textarea). */
  isEditable: boolean
  canGoBack: boolean
  canGoForward: boolean
}

/** One entry of the resolved menu. `command` routes through the registry;
 * `role` is a native clipboard action; `separator` is a divider. */
export type PageMenuItem =
  | { type: 'separator' }
  | { type: 'command'; command: string; params?: Record<string, unknown>; label: string; enabled: boolean }
  | { type: 'role'; role: 'cut' | 'copy' | 'paste' | 'selectAll'; label: string }

/** Decide the menu for a right-click. Always offers navigation (back / forward /
 * reload); adds a link group when on a link, and a clipboard group when in an
 * editable field or over a text selection. Groups are separated by dividers. */
export function buildPageMenu(ctx: PageContext): PageMenuItem[] {
  const items: PageMenuItem[] = [
    { type: 'command', command: 'back', label: 'Back', enabled: ctx.canGoBack },
    { type: 'command', command: 'forward', label: 'Forward', enabled: ctx.canGoForward },
    { type: 'command', command: 'reload', label: 'Reload', enabled: true }
  ]

  if (ctx.linkURL) {
    items.push(
      { type: 'separator' },
      {
        type: 'command',
        command: 'new-tab',
        params: { url: ctx.linkURL },
        label: 'Open Link in New Tab',
        enabled: true
      }
    )
  }

  if (ctx.isEditable) {
    items.push(
      { type: 'separator' },
      { type: 'role', role: 'cut', label: 'Cut' },
      { type: 'role', role: 'copy', label: 'Copy' },
      { type: 'role', role: 'paste', label: 'Paste' },
      { type: 'role', role: 'selectAll', label: 'Select All' }
    )
  } else if (ctx.selectionText) {
    items.push({ type: 'separator' }, { type: 'role', role: 'copy', label: 'Copy' })
  }

  return items
}
