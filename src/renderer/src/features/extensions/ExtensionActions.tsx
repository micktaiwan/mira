// Extension action buttons in the toolbar (Dark Reader's sun, a password
// manager's key…), rendered by the <browser-action-list> custom element that
// electron-chrome-extensions injects via our preload (injectBrowserAction).
// Clicking a button fires the extension's action or opens its popup — the lib
// anchors the popup in its own native child window, ABOVE the web content
// (exactly the parade of CLAUDE.md piège #3, nothing to invent here).
//
// The `partition` attribute is CRITICAL: the chrome runs on its own
// extension-free session (see chrome-session.ts), and without the attribute the
// element binds to the session it lives in — no extensions there. Main passes
// this window's profile partition in the query string (see loadRenderer); the
// default profile gets DEFAULT_SESSION_ALIAS, which the resolver installed in
// extensions.ts maps back to the default session.

/** This window's profile partition from the chrome url (?partition=…), or null
 * when missing (never in practice — loadRenderer always sets it). A window
 * never changes profile. */
function windowPartition(): string | null {
  const partition = new URLSearchParams(window.location.search).get('partition')
  return partition && partition !== '' ? partition : null
}

export default function ExtensionActions(): React.JSX.Element {
  const partition = windowPartition()
  // No `alignment` attribute: the default anchors the popup's RIGHT edge to the
  // button and grows it leftward+down — correct for buttons at the right end of
  // the toolbar ("bottom right" would grow it rightward, off the screen edge).
  return (
    <div className="extension-actions">
      <browser-action-list {...(partition ? { partition } : {})}></browser-action-list>
    </div>
  )
}
