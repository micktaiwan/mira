// The page-side half of "fill this login from the vault": a FRAME preload that,
// on request from the main process, puts a username and a password into the
// login form it can see, and says what it filled.
//
// Same injection idiom as the capture agent (login-capture-shim.ts): one preload
// registered on the web-page session, running in every frame of every tab, in
// the ISOLATED world. It is installed only on a profile MAPPED to a Bitwarden
// account, so an unmapped profile never receives this code at all.
//
// IT NEVER DECIDES ANYTHING ABOUT THE VAULT. The main process has already picked
// the account (login-fill.ts) and only hands over the two strings. This half
// answers one question — where do they go on this page — and nothing else: it
// never reads a value, never reports what was already typed (that is the capture
// agent's job, and duplicating it here would double the paths a password can
// travel), and never submits the form.
//
// WHY THE NATIVE SETTER: React, Vue and Angular track an input's value through
// the prototype's setter and ignore a plain `el.value = x` — the field looks
// filled to the eye and stays empty to the framework, which then submits
// nothing. Going through the prototype descriptor and firing input + change is
// what makes a controlled input actually register the value. Same technique as
// the /form command, which proved it on real signup pages.
//
// WHY IT FILLS THE USERNAME FIRST: two-step logins react to the identifier
// (revealing the password field, calling an API). Filling in DOM order would
// race that; username, then password, matches what a human does.

/** main -> frame: fill this pair. Sent per frame, never broadcast. */
export const LOGIN_FILL_APPLY_CHANNEL = 'mira:login-fill-apply'
/** frame -> main: what that frame filled (send, fire and forget). */
export const LOGIN_FILL_RESULT_CHANNEL = 'mira:login-fill-result'

/** The preload source. A string (not a module) because it is written to disk and
 * handed to session.registerPreloadScript, exactly like the capture agent. */
export const LOGIN_FILL_PRELOAD_SOURCE = `
const { ipcRenderer } = require('electron')
const APPLY = ${JSON.stringify(LOGIN_FILL_APPLY_CHANNEL)}
const RESULT = ${JSON.stringify(LOGIN_FILL_RESULT_CHANNEL)}

// Only real web documents. chrome-extension:// frames, devtools, about:blank and
// file:// pages have no account to log into.
const scheme = (location && location.protocol) || ''
if (scheme === 'http:' || scheme === 'https:') {
  // Mirrors classifyLoginField in login-capture.ts — the same vocabulary, so the
  // field the capture agent would READ is the field this one WRITES.
  const USERNAME_RE = /(user[\\s_-]?name|username|user\\b|login|log[\\s_-]?in|e-?mail|mail\\b|identifiant|pseudo|compte|account|nickname)/i
  const USERNAME_TYPES = ['', 'text', 'email', 'tel']

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
      el.getAttribute('autocomplete') || '',
      el.getAttribute('name') || '',
      el.id || '',
      el.getAttribute('placeholder') || '',
      el.getAttribute('aria-label') || '',
      labelText(el)
    ]
      .join(' ')
      .slice(0, 300)

  // A field a human could actually type into. A hidden or disabled input that
  // gets "filled" is the worst outcome there is: the page submits the old value
  // and the user is told the password is wrong.
  const fillable = (el) => {
    if (!el || el.disabled || el.readOnly) return false
    if (el.type === 'hidden') return false
    try {
      if (el.offsetParent === null && el.getClientRects().length === 0) return false
    } catch (_) {
      return false
    }
    return true
  }

  const isUsernameField = (el) => {
    const type = (el.getAttribute('type') || '').toLowerCase()
    if (USERNAME_TYPES.indexOf(type) === -1) return false
    const tokens = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/)
    if (tokens.indexOf('username') !== -1 || tokens.indexOf('email') !== -1) return true
    if (type === 'email') return true
    return USERNAME_RE.test(fieldText(el))
  }

  const setValue = (el, value) => {
    const proto =
      el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const desc = Object.getOwnPropertyDescriptor(proto, 'value')
    try {
      el.focus()
    } catch (_) {}
    if (desc && desc.set) desc.set.call(el, value)
    else el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    try {
      el.blur()
    } catch (_) {}
  }

  // The form the password belongs to, else the whole document: plenty of login
  // "forms" are a React div with no <form> at all.
  const rootFor = (el) => (el && el.form) || document

  // The identifier that goes with a password field: the LAST username-ish field
  // before it in document order, inside the same root. "Last before" is what
  // survives a page that also carries a search box or a newsletter input above
  // the form.
  const usernameFor = (root, password) => {
    const inputs = Array.prototype.slice
      .call(root.querySelectorAll('input, textarea'))
      .filter(fillable)
      .filter(isUsernameField)
    if (inputs.length === 0) return null
    if (!password) return inputs[0]
    let best = null
    for (const el of inputs) {
      const position = password.compareDocumentPosition(el)
      // Node.DOCUMENT_POSITION_PRECEDING = 2: el comes before the password.
      if (position & 2) best = el
    }
    return best || inputs[0]
  }

  ipcRenderer.on(APPLY, (_event, request) => {
    const req = request || {}
    let usernameFilled = false
    let passwordFilled = false
    let passwordFields = 0
    try {
      const passwords = Array.prototype.slice
        .call(document.querySelectorAll('input[type=password]'))
        .filter(fillable)
      passwordFields = passwords.length
      const password = passwords[0] || null
      const root = password ? rootFor(password) : document
      const username = usernameFor(root, password)
      // Username first: a two-step login reveals its password field only once
      // the identifier is in, and some sites call an API on change.
      if (req.username && username) {
        setValue(username, req.username)
        usernameFilled = true
      }
      if (req.password && password) {
        setValue(password, req.password)
        passwordFilled = true
      }
    } catch (_) {}
    try {
      ipcRenderer.send(RESULT, {
        token: req.token,
        url: location.href,
        usernameFilled: usernameFilled,
        passwordFilled: passwordFilled,
        passwordFields: passwordFields
      })
    } catch (_) {}
  })
}
`
