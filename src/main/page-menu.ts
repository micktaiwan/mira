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
  /** The kind of media under the cursor, from Electron's ContextMenuParams
   * (`none` when not on media). Only image / audio / video get a download item. */
  mediaType: string
  /** The media element's source URL, or '' when none. A `blob:` (or empty) video
   * src means a streamed video with no downloadable file — it needs yt-dlp. */
  srcURL: string
}

/** One entry of the resolved menu. `command` routes through the registry;
 * `role` is a native clipboard action; `separator` is a divider. */
export type PageMenuItem =
  | { type: 'separator' }
  | {
      type: 'command'
      command: string
      params?: Record<string, unknown>
      label: string
      enabled: boolean
    }
  | { type: 'role'; role: 'cut' | 'copy' | 'paste' | 'selectAll'; label: string }
  // A streamed video (blob:/MSE, no file URL): its download needs the precise
  // permalink resolved in-page at the click point, so the popup (not this pure
  // function) does the resolving and routes to `download-video-url`.
  | { type: 'download-stream'; label: string }
  // Chrome-style "Inspect": open the docked DevTools Elements panel and select
  // the right-clicked element. Needs the click coordinates (params.x/y), which
  // only the popup has, so like `download-stream` this pure function just emits
  // the intent and the popup resolves it against the live webContents.
  | { type: 'inspect-element'; label: string }

/** Decide the menu for a right-click. Always offers navigation (back / forward /
 * reload); adds a link group when on a link, and a clipboard group when in an
 * editable field or over a text selection. Groups are separated by dividers. */
export function buildPageMenu(ctx: PageContext): PageMenuItem[] {
  const items: PageMenuItem[] = [
    { type: 'command', command: 'back', label: 'Back', enabled: ctx.canGoBack },
    { type: 'command', command: 'forward', label: 'Forward', enabled: ctx.canGoForward },
    { type: 'command', command: 'reload', label: 'Reload', enabled: true }
  ]

  // Download the media under the cursor directly, without opening the gallery. A
  // real file URL (image/audio, or a plain-file video) downloads via the fetch
  // path; a streamed video (blob:/MSE) has no file, so it routes to yt-dlp.
  const mediaItem = buildMediaItem(ctx.mediaType, ctx.srcURL)
  if (mediaItem) items.push({ type: 'separator' }, mediaItem)

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

  // Always last, Chrome-style: inspect the element under the cursor.
  items.push({ type: 'separator' }, { type: 'inspect-element', label: 'Inspect Element' })

  return items
}

/** The single "Download <media>" item for a right-click on media, or null when
 * the cursor is not on downloadable media. An image or audio with a source URL,
 * and a video with a real (non-blob) file URL, download directly; a video with a
 * blob:/empty src is streamed (MSE/HLS) and gets the yt-dlp `download-stream`
 * item instead. Pure. */
export function buildMediaItem(mediaType: string, srcURL: string): PageMenuItem | null {
  if (mediaType === 'image' && srcURL) {
    return {
      type: 'command',
      command: 'download-media',
      params: { url: srcURL },
      label: 'Download Image',
      enabled: true
    }
  }
  if (mediaType === 'audio' && srcURL) {
    return {
      type: 'command',
      command: 'download-media',
      params: { url: srcURL },
      label: 'Download Audio',
      enabled: true
    }
  }
  if (mediaType === 'video') {
    const streamed = !srcURL || srcURL.startsWith('blob:')
    if (streamed) return { type: 'download-stream', label: 'Download Video' }
    return {
      type: 'command',
      command: 'download-media',
      params: { url: srcURL },
      label: 'Download Video',
      enabled: true
    }
  }
  return null
}
