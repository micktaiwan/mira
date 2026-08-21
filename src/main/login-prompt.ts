// The "save this login?" bubble — Mira's answer to Chrome's save-password
// prompt. Same child-window machinery as the card bubble (showPromptWindow in
// card-prompt.ts, which owns the window, the reveal and the answer promise);
// this file only writes the document and picks the size.
//
// It never shows the password, not even masked: the bubble names the ACCOUNT
// ("mickael@x.com on banco.mickaelfm.me"), which is what a human needs to decide,
// and the password stays in the main process until `bw` takes it.
//
// The 'update' mode is what makes this a password manager rather than a
// duplicate factory: when the vault already holds that account with a DIFFERENT
// password, the bubble says so and the answer edits the existing item instead of
// adding a second one.

import {
  PROMPT_CSS,
  escapeHtml,
  promptScript,
  showPromptWindow,
  type CardPromptHandle,
  type CardPromptOptions
} from './card-prompt'

/** What the login bubble asks for. 'save' when the vault is unlocked and the
 * account is new; 'unlock' when the master password is needed first; 'update'
 * when the account is already in the vault under another password. */
export type LoginPromptMode = 'save' | 'unlock' | 'update'

export interface LoginPromptRequest {
  mode: LoginPromptMode
  /** "mickael@x.com on banco.mickaelfm.me" — never the password. */
  loginLabel: string
  /** The Bitwarden account it would be written to, for the "which vault?" line. */
  account: string
  /** Set when a previous attempt failed, shown in red above the buttons. */
  error?: string
}

/** Outer size of the bubble, padding included. The unlock mode is taller because
 * it adds a password field. Pure. */
export function loginPromptSize(mode: LoginPromptMode): { width: number; height: number } {
  if (mode === 'unlock') return { width: 380, height: 250 }
  return { width: 380, height: 190 }
}

/** The bubble's document. Self-contained (shared CSS + the shared script), dark
 * like the rest of Mira's overlays. Pure. */
export function renderLoginPromptHtml(req: LoginPromptRequest): string {
  const updating = req.mode === 'update'
  const title = updating ? 'Update this login in Bitwarden?' : 'Save this login to Bitwarden?'
  const subject = `<p class="line"><span class="brand">${escapeHtml(req.loginLabel)}</span></p>`
  const note = updating ? '<p class="line">The vault holds another password for it.</p>' : ''
  const confirm = updating ? 'Update' : req.mode === 'unlock' ? 'Unlock and save' : 'Save'
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
${PROMPT_CSS}</style></head>
<body>
  <div class="card">
    <h1>${title}</h1>
    ${subject}
    ${note}
    <p class="line">Vault: ${escapeHtml(req.account)}</p>
    ${req.mode === 'unlock' ? '<input id="pw" type="password" placeholder="Master password" autofocus>' : ''}
    ${req.error ? `<p class="err">${escapeHtml(req.error)}</p>` : ''}
    <p class="busy" id="busy" hidden></p>
    <div class="row" id="row">
      <button id="no">Not now</button>
      <button id="yes" class="primary">${confirm}</button>
    </div>
  </div>
  <script>
    // Same contract as the card bubble: the window does not vanish on click, it
    // switches to a progress line while bw works and main closes it at the end.
${promptScript(updating ? 'Updating the login…' : 'Saving the login…')}
  </script>
</body></html>`
}

/** Show the login bubble and resolve with the answer (null = not now / closed).
 * The window itself belongs to showPromptWindow. */
export function showLoginPrompt(
  req: LoginPromptRequest,
  opts: CardPromptOptions
): CardPromptHandle {
  return showPromptWindow(renderLoginPromptHtml(req), loginPromptSize(req.mode), {
    ...opts,
    focus: req.mode === 'unlock',
    label: `login:${req.mode}`
  })
}
