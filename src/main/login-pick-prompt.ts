// The "which account?" bubble — the one moment where filling a login legitimately
// asks a question.
//
// It exists because of a rule Mira applies everywhere else in the other
// direction: the browser must not hand its work back to the user (CLAUDE.md,
// « faire travailler l'utilisateur final »). Which of two saved accounts you mean
// to log in with is not work Mira can do for you — it is the one thing only you
// know. Everything around it IS Mira's job, and is done before this window opens:
// the vault is found, unlocked, filtered down to the accounts that match this
// very site, and the choice made here is remembered, so the same site never asks
// twice (login-fill.ts, the memory store).
//
// Same child-window machinery as the save bubbles (showPromptWindow in
// card-prompt.ts, which owns the window, the reveal and the answer promise);
// this file only writes the document and picks the size.
//
// It never shows a password, not even masked. Each row names an ACCOUNT — the
// username, and the address it is filed under when that differs from the page —
// which is what a human needs to choose. The password stays in the main process
// until the page agent puts it in the form.

import {
  PROMPT_CSS,
  escapeHtml,
  showPromptWindow,
  type CardPromptHandle,
  type CardPromptOptions
} from './card-prompt'

/** One account to choose from. Mirrors FillCandidate (login-fill.ts) minus what
 * the bubble has no use for. */
export interface LoginPickOption {
  id: string
  /** The account's login name. May be empty: some vault items only carry a
   * password. */
  username: string
  /** The item's name in the vault, shown when there is no username to show. */
  name: string
  /** True when the item is filed under the page's very host, false when it only
   * shares the site. */
  exact: boolean
  /** The address to show under the username for a non-exact entry, '' when
   * there is nothing worth adding. */
  host: string
}

export interface LoginPickRequest {
  /** The page being filled ("eu.holistics.io"). */
  host: string
  /** The Bitwarden account the options come from, for the "which vault?" line. */
  account: string
  options: LoginPickOption[]
}

/** How many rows the bubble draws. Beyond that the list is cut and the count is
 * said in a line — a scrolling bubble is worse than a shorter one, and a site
 * with more than eight saved accounts is better served by `list-logins`. */
export const MAX_PICK_OPTIONS = 8

/** Outer size of the bubble, padding included: it grows one row at a time and
 * stops at MAX_PICK_OPTIONS. Pure. */
export function loginPickSize(count: number): { width: number; height: number } {
  const rows = Math.min(Math.max(count, 1), MAX_PICK_OPTIONS)
  const cut = count > MAX_PICK_OPTIONS ? 18 : 0
  return { width: 380, height: 128 + rows * 42 + cut }
}

/** What a row says: the username, or the item's name when the item has none.
 * Pure. */
export function pickOptionLabel(option: LoginPickOption): string {
  const username = option.username.trim()
  if (username !== '') return username
  const name = option.name.trim()
  return name !== '' ? `${name} (no username)` : '(no username)'
}

/** The second line of a row, or '' when there is nothing to add. It only ever
 * appears for an account filed under ANOTHER address of the same site — which is
 * exactly the case where two rows would otherwise look identical. Pure. */
export function pickOptionNote(option: LoginPickOption): string {
  if (option.exact) return ''
  const host = option.host.trim()
  return host === '' ? '' : `saved on ${host}`
}

/** The bubble's document. Self-contained, dark like the rest of Mira's overlays.
 * Pure. */
export function renderLoginPickHtml(req: LoginPickRequest): string {
  const shown = req.options.slice(0, MAX_PICK_OPTIONS)
  const hidden = req.options.length - shown.length
  const rows = shown
    .map((option) => {
      const note = pickOptionNote(option)
      return `<button class="pick" data-id="${escapeHtml(option.id)}">
        <span class="who">${escapeHtml(pickOptionLabel(option))}</span>
        ${note ? `<span class="where">${escapeHtml(note)}</span>` : ''}
      </button>`
    })
    .join('\n')
  const more = hidden > 0 ? `<p class="line">and ${hidden} more in the vault</p>` : ''
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
${PROMPT_CSS}
  .pick {
    display: block;
    width: 100%;
    text-align: left;
    margin: 6px 0 0;
    padding: 7px 10px;
    background: #1e1e1e;
  }
  .pick:first-of-type { margin-top: 10px; }
  .pick .who { display: block; font-weight: 600; }
  .pick .where { display: block; color: rgba(255, 255, 245, 0.62); font-size: 11px; }
</style></head>
<body>
  <div class="card">
    <h1>Which account for ${escapeHtml(req.host)}?</h1>
    <p class="line">Vault: ${escapeHtml(req.account)}</p>
    ${rows}
    ${more}
    <p class="busy" id="busy" hidden></p>
    <div class="row" id="row">
      <button id="no">Not now</button>
    </div>
  </div>
  <script>
    // Its own script rather than the shared promptScript: that one drives a
    // yes/no pair, this one an arbitrary number of rows. Same contract though —
    // the window does not vanish on click, it switches to a progress line and
    // main closes it once the form is filled.
    let done = false;
    const busyEl = document.getElementById('busy');
    const row = document.getElementById('row');
    const picks = Array.prototype.slice.call(document.querySelectorAll('.pick'));
    window.miraCardBusy = (label) => {
      busyEl.textContent = label;
      busyEl.hidden = false;
      row.hidden = true;
      picks.forEach((b) => { b.disabled = true; });
    };
    const answer = (payload) => {
      if (done) return;
      done = true;
      if (payload) window.miraCardBusy('Filling the form…');
      window.miraCardPrompt.answer(JSON.stringify(payload));
    };
    picks.forEach((button) => {
      button.addEventListener('click', () => answer({ action: 'pick', id: button.dataset.id }));
    });
    document.getElementById('no').addEventListener('click', () => answer(null));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') answer(null); });
    if (picks[0]) picks[0].focus();
  </script>
</body></html>`
}

/** Show the picker and resolve with the answer (null = not now / closed).
 *
 * `raise` is on, unlike the save bubble: this window answers a fill the user
 * asked for from somewhere else (a socket call, a shortcut), and a child window
 * shown behind a hidden parent looks like nothing happened at all. */
export function showLoginPick(req: LoginPickRequest, opts: CardPromptOptions): CardPromptHandle {
  return showPromptWindow(renderLoginPickHtml(req), loginPickSize(req.options.length), {
    ...opts,
    raise: true,
    focus: true,
    label: 'login:pick'
  })
}
