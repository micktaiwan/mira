// The page-side half of form memory: a FRAME preload that reports what was typed
// into ordinary text fields, and offers the remembered values back through a
// native <datalist> popup.
//
// Same injection idiom as the card capture shim (card-capture-shim.ts): one
// preload registered on the web-page session, running in every frame of every
// tab, in the ISOLATED world — the page cannot see it, detect it or call it.
//
// WHY A DATALIST AND NOT A DROPDOWN OF OUR OWN: Electron compiles Chromium's
// datalist autofill popup (shell/browser/ui/views/autofill_popup_view.cc plus
// shell/renderer/electron_autofill_agent.cc — verified present in the shipped
// framework binary), so binding the field to a <datalist> gets a native popup,
// native keyboard navigation and native filtering for a dozen lines. The only
// footprint on the page is a `list` attribute and one hidden <datalist>.
//
// It classifies almost nothing: the main process owns the rule (shouldRemember in
// form-memory.ts). The shim only refuses to READ what must never travel at all —
// passwords, one-time codes, and non-textual inputs.

/** A frame reports one typed field on this channel (send, fire and forget). */
export const FORM_MEMORY_RECORD_CHANNEL = 'mira:form-memory-record'
/** A frame asks for a field's remembered values on this one (invoke). */
export const FORM_MEMORY_SUGGEST_CHANNEL = 'mira:form-memory-suggest'

/** The preload source, as a string: it is written to disk and handed to
 * session.registerPreloadScript, exactly like the card capture shim. */
export const FORM_MEMORY_PRELOAD_SOURCE = `
const { ipcRenderer } = require('electron')
const RECORD = ${JSON.stringify(FORM_MEMORY_RECORD_CHANNEL)}
const SUGGEST = ${JSON.stringify(FORM_MEMORY_SUGGEST_CHANNEL)}

// Only real web documents: chrome-extension:// frames, devtools and about:blank
// have no form worth remembering and no business being read.
const scheme = (location && location.protocol) || ''
if (scheme === 'http:' || scheme === 'https:') {
  const TEXTUAL_TYPES = ['', 'text', 'search', 'tel', 'url', 'email', 'number']
  const SECRET_TOKENS = ['one-time-code', 'current-password', 'new-password']
  const SECRET_RE = /(password|passwd|pwd\\b|mot[\\s_-]?de[\\s_-]?passe|secret|otp\\b|one[\\s_-]?time|token|captcha)/i
  const DATALIST_ID = 'mira-form-memory'
  // Fields we already wired, tracked in the isolated world so the page cannot
  // see the marker (a data-* attribute would be visible to it).
  const wired = new WeakSet()

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

  const attrsOf = (el) => ({
    autocomplete: el.getAttribute('autocomplete') || '',
    name: el.getAttribute('name') || '',
    id: el.id || '',
    placeholder: el.getAttribute('placeholder') || '',
    ariaLabel: el.getAttribute('aria-label') || '',
    label: labelText(el).trim().slice(0, 200),
    type: (el.type || '').toLowerCase()
  })

  // The only thing the shim decides: whether this field may be READ at all. The
  // rest of the rule (cards, value shape, caps) lives in the main process.
  const readable = (el) => {
    if (!el || el.tagName !== 'INPUT') return false
    const type = (el.type || '').toLowerCase()
    if (TEXTUAL_TYPES.indexOf(type) === -1) return false
    const tokens = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/)
    for (const token of tokens) {
      if (SECRET_TOKENS.indexOf(token) !== -1) return false
    }
    const text = [
      el.getAttribute('name'),
      el.id,
      el.getAttribute('placeholder'),
      el.getAttribute('aria-label'),
      labelText(el)
    ]
      .filter(Boolean)
      .join(' ')
    return !SECRET_RE.test(text)
  }

  const record = (el) => {
    if (!readable(el)) return
    const value = typeof el.value === 'string' ? el.value.trim() : ''
    if (!value) return
    try {
      ipcRenderer.send(RECORD, { attrs: attrsOf(el), value, url: location.href })
    } catch (_) {}
  }

  // Bind the field to a <datalist> holding what was typed here before. Chromium
  // owns the popup from there: it opens it, filters it as the user types, and
  // fills the field on pick.
  const offer = (el) => {
    if (!readable(el) || wired.has(el)) return
    // A page that ships its own datalist keeps it — never fight the site.
    if (el.getAttribute('list')) return
    wired.add(el)
    ipcRenderer
      .invoke(SUGGEST, { attrs: attrsOf(el), url: location.href })
      .then((values) => {
        if (!Array.isArray(values) || values.length === 0) return
        if (document.activeElement !== el) return
        let list = document.getElementById(DATALIST_ID)
        if (!list) {
          list = document.createElement('datalist')
          list.id = DATALIST_ID
          document.documentElement.appendChild(list)
        }
        list.textContent = ''
        for (const value of values) {
          const option = document.createElement('option')
          option.value = value
          list.appendChild(option)
        }
        el.setAttribute('list', DATALIST_ID)
      })
      .catch(() => {})
  }

  // focusin arms the field before the user types; focusout (not blur, which does
  // not bubble) catches "typed it, moved on"; change catches pastes and
  // programmatic fills; submit sweeps the whole form for the field still focused
  // when the button is clicked.
  document.addEventListener('focusin', (e) => offer(e.target), true)
  document.addEventListener('focusout', (e) => record(e.target), true)
  document.addEventListener('change', (e) => record(e.target), true)
  document.addEventListener(
    'submit',
    (e) => {
      const form = e.target
      if (!form || !form.elements) return
      for (const el of Array.from(form.elements)) record(el)
    },
    true
  )
}
`
