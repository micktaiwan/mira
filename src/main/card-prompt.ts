// The "save this card?" bubble — Mira's answer to Chrome's save-card prompt.
//
// It is a small CHILD WINDOW, not a DOM node in the chrome: a WebContentsView
// composites ABOVE everything the renderer draws, so an HTML bubble overlapping
// the page would be hidden behind it (the native gotcha #3 in
// .claude/rules/main-native-gotchas.md). The command palette solves that by
// HIDING the page; a save-card prompt cannot — you are mid-checkout and must keep
// seeing the form. Hence a native window, like the tooltip and the toast, but
// clickable.
//
// Split for testability: the view model, the HTML and the result parsing are pure
// functions; only showCardPrompt touches Electron.

import { BrowserWindow, type IpcMainEvent } from 'electron'

/** ipc channel the bubble page answers on. */
export const CARD_PROMPT_ANSWER_CHANNEL = 'mira:card-prompt-answer'

/** Preload for the bubble: the single call it can make back to main. */
export const CARD_PROMPT_PRELOAD_SOURCE = `const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('miraCardPrompt', {
  answer: (payload) => ipcRenderer.send(${JSON.stringify(CARD_PROMPT_ANSWER_CHANNEL)}, String(payload || '')),
})
`

/** What the bubble asks for. 'save' when the vault is already unlocked; 'unlock'
 * when the master password is still needed to save a card; 'unlock-vault' when
 * there is no card at all and Mira only needs the vault open (reading the cards
 * back, for instance). */
export type CardPromptMode = 'save' | 'unlock' | 'unlock-vault'

export interface CardPromptRequest {
  mode: CardPromptMode
  /** "Visa 4242" — never the full number. Empty in 'unlock-vault' mode. */
  cardLabel: string
  /** The site the card was typed on ("shop.example.com"), '' if unknown. */
  host: string
  /** The Bitwarden account it would be saved to, for the "which vault?" line. */
  account: string
  /** Set when a previous attempt failed, shown in red above the buttons. */
  error?: string
}

/** The user's answer: save now, unlock-then-save with this password, or null for
 * "not now" / closed. */
export type CardPromptAnswer = { action: 'save' } | { action: 'unlock'; password: string }

/** Parse what the bubble reports. Anything unexpected is a dismissal — the safe
 * default, since a misread must never save a card by accident. Pure. */
export function parsePromptAnswer(raw: unknown): CardPromptAnswer | null {
  if (typeof raw !== 'string' || raw === '') return null
  let obj: { action?: unknown; password?: unknown }
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  if (obj.action === 'save') return { action: 'save' }
  if (obj.action === 'unlock' && typeof obj.password === 'string' && obj.password !== '') {
    return { action: 'unlock', password: obj.password }
  }
  return null
}

/** HTML-escape before embedding untrusted text (a page's host) in the markup.
 * Pure. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Outer size of the bubble window, padding included. Two sizes because the
 * unlock mode adds a password field. Pure. */
export function promptSize(mode: CardPromptMode): { width: number; height: number } {
  if (mode === 'unlock') return { width: 380, height: 250 }
  if (mode === 'unlock-vault') return { width: 380, height: 210 }
  return { width: 380, height: 190 }
}

/** Where the bubble sits inside the window: top-right of the content area, just
 * under the toolbar, the way Chrome anchors its save-card bubble to the omnibox.
 * Pure geometry so it is unit-tested. */
export function promptBounds(
  windowBounds: { x: number; y: number; width: number; height: number },
  size: { width: number; height: number },
  toolbarHeight = 40
): { x: number; y: number; width: number; height: number } {
  const margin = 8
  const x = windowBounds.x + Math.max(0, windowBounds.width - size.width - margin)
  const y = windowBounds.y + toolbarHeight
  return { x, y, width: size.width, height: size.height }
}

/** The bubble's document. Self-contained (inline CSS + one script), dark like the
 * rest of Mira's overlays. Pure. */
export function renderCardPromptHtml(req: CardPromptRequest): string {
  const where = req.host ? ` on ${escapeHtml(req.host)}` : ''
  const unlocking = req.mode === 'unlock' || req.mode === 'unlock-vault'
  const vaultOnly = req.mode === 'unlock-vault'
  const title = vaultOnly ? 'Unlock the Bitwarden vault?' : 'Save this card to Bitwarden?'
  const subject = vaultOnly
    ? ''
    : `<p class="line"><span class="brand">${escapeHtml(req.cardLabel)}</span>${where}</p>`
  const confirm = vaultOnly ? 'Unlock' : unlocking ? 'Unlock and save' : 'Save'
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; background: transparent; overflow: hidden; }
  body {
    padding: 10px;
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: rgba(255, 255, 245, 0.92);
  }
  .card {
    background: #282828;
    border: 1px solid #414853;
    border-radius: 10px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.55);
    padding: 14px 16px;
  }
  h1 { font-size: 13px; font-weight: 600; margin: 0 0 8px; }
  .line { color: rgba(255, 255, 245, 0.62); font-size: 12px; margin: 0 0 4px; }
  .brand { font-weight: 600; color: rgba(255, 255, 245, 0.92); }
  input {
    width: 100%;
    box-sizing: border-box;
    margin: 10px 0 2px;
    padding: 7px 9px;
    background: #1e1e1e;
    border: 1px solid #414853;
    border-radius: 6px;
    color: inherit;
    font: inherit;
  }
  input:focus { outline: none; border-color: #6988e6; }
  .err { color: #ef6f6f; font-size: 12px; margin: 8px 0 0; }
  .busy { color: rgba(255, 255, 245, 0.62); font-size: 12px; margin: 12px 0 2px; }
  .row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
  button {
    padding: 6px 12px;
    border-radius: 6px;
    border: 1px solid #414853;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  button.primary { background: #6988e6; border-color: #6988e6; color: #10131a; font-weight: 600; }
  button:hover { border-color: #6988e6; }
</style></head>
<body>
  <div class="card">
    <h1>${title}</h1>
    ${subject}
    <p class="line">Vault: ${escapeHtml(req.account)}</p>
    ${unlocking ? '<input id="pw" type="password" placeholder="Master password" autofocus>' : ''}
    ${req.error ? `<p class="err">${escapeHtml(req.error)}</p>` : ''}
    <p class="busy" id="busy" hidden></p>
    <div class="row" id="row">
      <button id="no">Not now</button>
      <button id="yes" class="primary">${confirm}</button>
    </div>
  </div>
  <script>
    // The vault work behind this button is SLOW: bw derives the key and talks to
    // the server, several seconds. So the bubble does NOT vanish on click — it
    // switches to a progress line (set here immediately, then updated by main
    // through miraCardBusy) and closes only once the card is really saved.
    let done = false;
    const busyEl = document.getElementById('busy');
    const row = document.getElementById('row');
    window.miraCardBusy = (label) => {
      busyEl.textContent = label;
      busyEl.hidden = false;
      row.hidden = true;
      const pwEl = document.getElementById('pw');
      if (pwEl) pwEl.disabled = true;
    };
    const answer = (payload) => {
      if (done) return;
      done = true;
      if (payload) {
        window.miraCardBusy(
          payload.action === 'unlock' ? 'Unlocking the vault…' : 'Saving the card…'
        );
      }
      window.miraCardPrompt.answer(JSON.stringify(payload));
    };
    const pw = document.getElementById('pw');
    document.getElementById('no').addEventListener('click', () => answer(null));
    document.getElementById('yes').addEventListener('click', () => {
      if (pw) answer({ action: 'unlock', password: pw.value });
      else answer({ action: 'save' });
    });
    if (pw) {
      pw.focus();
      pw.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') answer({ action: 'unlock', password: pw.value });
      });
    }
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') answer(null); });
  </script>
</body></html>`
}

/** JS (for executeJavaScript) that swaps the bubble to a progress line. Pure. */
export function busyScript(label: string): string {
  return `window.miraCardBusy && window.miraCardBusy(${JSON.stringify(label)})`
}

/** A bubble that is up: its eventual answer, a way to show progress in place
 * while `bw` works, and a way to close it. */
export interface CardPromptHandle {
  answer: Promise<CardPromptAnswer | null>
  /** Replace the buttons with a progress line (the window stays up). */
  busy: (label: string) => void
  close: () => void
}

export interface CardPromptOptions {
  /** The profile window the bubble belongs to. */
  parent: BrowserWindow
  /** On-disk path of CARD_PROMPT_PRELOAD_SOURCE. */
  preloadPath: string
  /** Bring the parent window to the front first, and take focus.
   *
   * WHY IT MATTERS: a child window is only ever visible on top of its parent, so
   * when Mira is behind the terminal (or on another macOS Space), a bubble shown
   * with showInactive is drawn where nobody can see it — it looks like nothing
   * happened. That is fine for the save prompt, which fires while the user is
   * typing INTO a Mira page, and wrong for a prompt that answers a command the
   * user just ran somewhere else. */
  raise?: boolean
}

/** Show the bubble and resolve with the answer (null = not now / closed). The
 * only impure function here.
 *
 * showInactive keeps the keyboard focus in the checkout field: the bubble appears
 * beside what you are doing instead of stealing the caret, and only takes focus
 * if you actually click it. */
export function showCardPrompt(req: CardPromptRequest, opts: CardPromptOptions): CardPromptHandle {
  const size = promptSize(req.mode)
  const win = new BrowserWindow({
    parent: opts.parent,
    ...size,
    ...promptBounds(opts.parent.getContentBounds(), size),
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  let settle: (value: CardPromptAnswer | null) => void = () => {}
  const answer = new Promise<CardPromptAnswer | null>((resolve) => {
    settle = resolve
  })
  {
    let settled = false
    const finish = (value: CardPromptAnswer | null): void => {
      if (settled) return
      settled = true
      settle(value)
      // NOT closed here: the caller keeps the bubble up to show progress while
      // the vault work runs, and closes it when that is done. A dismissal is the
      // exception — nothing follows it, so the window goes at once.
      if (value === null && !win.isDestroyed()) win.close()
    }
    win.webContents.ipc.on(CARD_PROMPT_ANSWER_CHANNEL, (_event: IpcMainEvent, raw: string) => {
      finish(parsePromptAnswer(raw))
    })
    win.on('closed', () => finish(null))
    // Show on whichever comes first: ready-to-show is the reliable one for a
    // transparent, frameless window (it is what the other native pickers use),
    // did-finish-load is the fallback. Guarded so the second one is a no-op.
    let shown = false
    const reveal = (via: string): void => {
      if (shown || win.isDestroyed()) return
      shown = true
      console.log(`[mira-card] prompt reveal via ${via} mode=${req.mode} raise=${!!opts.raise}`)
      if (opts.raise && !opts.parent.isDestroyed()) {
        // Surface the whole stack: the parent first (a child window cannot be
        // seen in front of a hidden parent), then the bubble.
        if (opts.parent.isMinimized()) opts.parent.restore()
        opts.parent.show()
      }
      // Inactive: the caret stays in the payment form the user is still filling.
      win.showInactive()
      // The password field is useless without focus, so those modes do take it.
      if (opts.raise || req.mode === 'unlock' || req.mode === 'unlock-vault') win.focus()
      console.log(
        `[mira-card] prompt visible=${win.isVisible()} bounds=${JSON.stringify(win.getBounds())}`
      )
    }
    win.webContents.once('did-finish-load', () => reveal('did-finish-load'))
    win.once('ready-to-show', () => reveal('ready-to-show'))
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderCardPromptHtml(req))}`)
  }

  return {
    answer,
    busy: (label) => {
      if (!win.isDestroyed()) void win.webContents.executeJavaScript(busyScript(label))
    },
    close: () => {
      if (!win.isDestroyed()) win.close()
    }
  }
}
