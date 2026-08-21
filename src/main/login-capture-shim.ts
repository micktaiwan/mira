// The page-side half of login capture: a FRAME preload that watches login forms
// and reports the pair that was typed, plus whether the user actually tried to
// log in. Same injection idiom as the card capture shim (card-capture-shim.ts):
// one preload registered on the web-page session, running in every frame of
// every tab, in the ISOLATED world — the page cannot see it, detect it, or call
// it.
//
// It is only ever installed on a profile MAPPED to a Bitwarden account
// (login-service.ts). An unmapped profile never gets this code, so its passwords
// are not merely ignored, they are never read.
//
// WHAT IT DECIDES AND WHAT IT DOES NOT: it mirrors collectLogin / classifyLoginField
// from login-capture.ts (those pure functions are the spec, and their unit tests
// are what pin this behavior). Everything after that — the TTL, the two-step
// merge, the "is it already in the vault" check, the prompt — lives in the main
// process.
//
// WHEN IT REPORTS:
//   - focusout / change: the halves, WITHOUT `submitted`. This is what carries
//     the email of a two-step login (type it, press Continue, land on a password
//     page) across to the second page.
//   - submit, Enter in a field, or a click on a button whose label means "log
//     in": the same halves WITH `submitted: true`. Only that arms the prompt.
// A click on any other button (a "show password" eye, a cookie banner) is NOT a
// submit, which is why the button text is matched instead of any click counting.

/** ipc channel a frame reports a login on (send, fire and forget). */
export const LOGIN_FRAGMENT_CHANNEL = 'mira:login-fragment'

/** The preload source. A string (not a module) because it is written to disk and
 * handed to session.registerPreloadScript, exactly like the card capture shim. */
export const LOGIN_CAPTURE_PRELOAD_SOURCE = `
const { ipcRenderer } = require('electron')
const CHANNEL = ${JSON.stringify(LOGIN_FRAGMENT_CHANNEL)}

// Only real web documents. chrome-extension:// frames, devtools, about:blank and
// file:// pages have no account to log into and no business being read.
const scheme = (location && location.protocol) || ''
if (scheme === 'http:' || scheme === 'https:') {
  const USERNAME_RE = /(user[\\s_-]?name|username|user\\b|login|log[\\s_-]?in|e-?mail|mail\\b|identifiant|pseudo|compte|account|nickname)/i
  const NEW_PASSWORD_RE = /(new|confirm|repeat|retype|verify|again|nouveau|nouvelle|confirmer|r[ée]p[ée]t|v[ée]rif)/i
  const SUBMIT_RE = /(log[\\s-]?in|sign[\\s-]?in|sign[\\s-]?up|register|submit|continue|next|se[\\s-]?connecter|connexion|s'identifier|identifier|valider|continuer|suivant|s'inscrire|inscription|cr[ée]er[\\s-]?(mon|un)?[\\s-]?compte)/i
  const USERNAME_TYPES = ['', 'text', 'email', 'tel']
  const MAX = 200

  // The visible text tied to a field: its <label for>, an ancestor <label>, or
  // aria-label. Sites that set no name/id often still have a label.
  const labelText = (el) => {
    try {
      if (el.id) {
        const byFor = document.querySelector('label[for="' + CSS.escape(el.id) + '"]')
        if (byFor && byFor.textContent) return byFor.textContent
      }
      const parent = el.closest && el.closest('label')
      if (parent && parent.textContent) return parent.textContent
    } catch (_) {}
    return ''
  }

  const fieldText = (el) =>
    [
      el.getAttribute('name'),
      el.id,
      el.getAttribute('placeholder'),
      el.getAttribute('aria-label'),
      labelText(el)
    ]
      .filter(Boolean)
      .join(' ')

  // Mirrors classifyLoginField in login-capture.ts.
  const classify = (el) => {
    if (!el || el.tagName !== 'INPUT') return null
    const type = (el.type || '').toLowerCase()
    const tokens = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/)
    if (type === 'password') {
      if (tokens.indexOf('new-password') !== -1) return 'new-password'
      if (tokens.indexOf('current-password') !== -1) return 'password'
      return NEW_PASSWORD_RE.test(fieldText(el)) ? 'new-password' : 'password'
    }
    if (USERNAME_TYPES.indexOf(type) === -1) return null
    if (tokens.indexOf('username') !== -1 || tokens.indexOf('email') !== -1) return 'username'
    if (type === 'email') return 'username'
    const text = fieldText(el)
    return text && USERNAME_RE.test(text) ? 'username' : null
  }

  // Mirrors collectLogin in login-capture.ts: 1 filled password wins outright;
  // 2+ only when the last two AGREE (new + confirmation), so a half-typed or
  // mistyped confirmation reports nothing at all.
  const collect = (root) => {
    let inputs = []
    try {
      inputs = Array.from(root.querySelectorAll('input'))
    } catch (_) {
      return null
    }
    const passwords = []
    const usernames = []
    for (const el of inputs) {
      const kind = classify(el)
      if (kind === 'password' || kind === 'new-password') passwords.push({ el, kind })
      else if (kind === 'username') usernames.push(el)
    }
    const filled = passwords.filter((p) => typeof p.el.value === 'string' && p.el.value !== '')
    let password = ''
    let kind = 'current'
    if (filled.length === 1) {
      password = filled[0].el.value
      kind = filled[0].kind === 'new-password' ? 'new' : 'current'
    } else if (filled.length >= 2) {
      const last = filled[filled.length - 1].el.value
      const previous = filled[filled.length - 2].el.value
      if (last === previous) {
        password = last
        kind = 'new'
      }
    }
    let username = ''
    for (const el of usernames) {
      const value = typeof el.value === 'string' ? el.value.trim() : ''
      if (value) {
        username = value
        break
      }
    }
    return {
      username: username.slice(0, MAX),
      password: password.slice(0, MAX),
      kind,
      hasUsernameField: usernames.length > 0
    }
  }

  // The form the field belongs to, else the whole document: plenty of login
  // "forms" are a React div with no <form> at all.
  const rootFor = (el) => (el && el.form) || document

  // Identical consecutive reports are dropped (focusout fires a lot), but a
  // submit always goes through: it is the event that arms the prompt.
  let last = ''
  const send = (root, submitted) => {
    const pair = collect(root)
    if (!pair || (!pair.username && !pair.password)) return
    const payload = {
      username: pair.username,
      password: pair.password,
      kind: pair.kind,
      hasUsernameField: pair.hasUsernameField,
      submitted: !!submitted,
      url: location.href
    }
    // The dedup key deliberately leaves the password OUT: a second copy of it,
    // kept alive in a closure between two events, buys nothing.
    const key = payload.username + '|' + payload.kind + '|' + payload.password.length
    if (!submitted && key === last) return
    last = key
    try {
      ipcRenderer.send(CHANNEL, payload)
    } catch (_) {}
  }

  const watched = (el) => {
    const kind = classify(el)
    return kind === 'password' || kind === 'new-password' || kind === 'username'
  }

  // A click that means "log me in", as opposed to a "show password" eye or a
  // cookie banner: the element's own text / value / aria-label has to say so, or
  // it has to be a real submit control.
  const looksLikeSubmit = (el) => {
    const control = el.closest && el.closest('button, input[type=submit], [role=button], a')
    if (!control) return false
    const type = (control.getAttribute('type') || '').toLowerCase()
    if (control.tagName === 'INPUT' && type === 'submit') return true
    if (control.tagName === 'BUTTON' && type !== 'button' && type !== 'reset' && control.form) {
      return true
    }
    const text = [
      control.textContent,
      control.getAttribute('value'),
      control.getAttribute('aria-label'),
      control.getAttribute('name'),
      control.id
    ]
      .filter(Boolean)
      .join(' ')
      .slice(0, 200)
    return SUBMIT_RE.test(text)
  }

  document.addEventListener('focusout', (e) => {
    if (watched(e.target)) send(rootFor(e.target), false)
  }, true)
  document.addEventListener('change', (e) => {
    if (watched(e.target)) send(rootFor(e.target), false)
  }, true)
  document.addEventListener('submit', (e) => send(e.target || document, true), true)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    if (!watched(e.target)) return
    send(rootFor(e.target), true)
  }, true)
  document.addEventListener('click', (e) => {
    const el = e.target
    if (!el || !el.closest) return
    if (!looksLikeSubmit(el)) return
    const form = el.closest('form')
    send(form || document, true)
  }, true)
}
`
