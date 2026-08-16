// The page-side half of card capture: a FRAME preload that watches card fields
// and reports what was typed to the main process. Same injection idiom as the
// getUserMedia shim (media-device-picker-shim.ts): one preload registered on the
// web-page session, running in every frame of every tab.
//
// WHY A FRAME PRELOAD AND NOT A CONTENT SCRIPT OR CDP:
//   - The number you type at a checkout usually lives in a CROSS-ORIGIN iframe
//     owned by the payment provider. A frame preload runs INSIDE that iframe's
//     renderer (tab views are created with nodeIntegrationInSubFrames: true, see
//     profiles.ts), which is the only way to see the value at all.
//   - It runs in the ISOLATED world, so the page never sees this code, cannot
//     detect it, and cannot call it.
//
// It reports FRAGMENTS, not cards: one frame typically holds only the number, or
// only the expiry. Assembly happens per tab in the main process (card-capture.ts).
// The security code is classified only to be skipped — it is never read, never
// sent, never stored.

/** ipc channel a frame uses to report one card field. */
export const CARD_FRAGMENT_CHANNEL = 'mira:card-fragment'

/** The preload source. A string (not a module) because it is written to disk and
 * handed to session.registerPreloadScript, exactly like the getUserMedia shim.
 * Its classification MUST mirror classifyField in card-capture.ts — that pure
 * function is the spec, and its unit tests are what pin this behavior. */
export const CARD_CAPTURE_PRELOAD_SOURCE = `
const { ipcRenderer } = require('electron')
const CHANNEL = ${JSON.stringify(CARD_FRAGMENT_CHANNEL)}

// Only real web documents. chrome-extension:// frames, devtools and about:blank
// have no checkout to watch and no business being read.
const scheme = (location && location.protocol) || ''
if (scheme === 'http:' || scheme === 'https:' || scheme === 'file:') {
  const AUTOCOMPLETE_KINDS = {
    'cc-number': 'number',
    'cc-exp': 'expiry',
    'cc-exp-month': 'exp-month',
    'cc-exp-year': 'exp-year',
    'cc-name': 'holder',
    'cc-csc': 'cvc'
  }
  const CVC_RE = /(cvc|cvv|csc|cid\\b|security[\\s_-]?code|card[\\s_-]?code|crypto|verification)/i
  const NUMBER_RE = /(card[\\s_-]?number|cardnum|ccnum|cc[\\s_-]?number|num[ée]ro[\\s_-]?(de[\\s_-]?)?carte|pan\\b)/i
  const EXPIRY_RE = /(exp(iry|iration)?[\\s_-]?(date)?|valid[\\s_-]?(thru|until)|mm[\\s_/-]{0,3}(yy|aa))/i
  const MONTH_RE = /(exp.*month|month.*exp|mois)/i
  const YEAR_RE = /(exp.*year|year.*exp|annee|année)/i
  const HOLDER_RE = /(card[\\s_-]?holder|name[\\s_-]?on[\\s_-]?card|titulaire|nom[\\s_-]?carte)/i
  const TEXTUAL_TYPES = ['text', 'tel', 'number', 'search', '']

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

  const classify = (el) => {
    const type = (el.type || '').toLowerCase()
    if (type && TEXTUAL_TYPES.indexOf(type) === -1) return null
    const tokens = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/)
    for (const token of tokens) {
      if (AUTOCOMPLETE_KINDS[token]) return AUTOCOMPLETE_KINDS[token]
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
    if (!text) return null
    if (CVC_RE.test(text)) return 'cvc'
    if (NUMBER_RE.test(text)) return 'number'
    if (MONTH_RE.test(text)) return 'exp-month'
    if (YEAR_RE.test(text)) return 'exp-year'
    if (EXPIRY_RE.test(text)) return 'expiry'
    if (HOLDER_RE.test(text)) return 'holder'
    return null
  }

  const report = (el) => {
    if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'SELECT')) return
    const kind = classify(el)
    // 'cvc' stops here: the security code is never read.
    if (!kind || kind === 'cvc') return
    const value = typeof el.value === 'string' ? el.value.trim() : ''
    if (!value) return
    try {
      ipcRenderer.send(CHANNEL, { kind, value, frameOrigin: location.origin })
    } catch (_) {}
  }

  // focusout (not blur, which does not bubble) catches "typed it, moved on";
  // change catches selects and autofilled values; submit sweeps the whole form
  // for the case where the last field is still focused when Pay is clicked.
  document.addEventListener('focusout', (e) => report(e.target), true)
  document.addEventListener('change', (e) => report(e.target), true)
  document.addEventListener(
    'submit',
    (e) => {
      const form = e.target
      if (!form || !form.elements) return
      for (const el of Array.from(form.elements)) report(el)
    },
    true
  )
}
`
