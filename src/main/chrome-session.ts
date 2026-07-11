// The session partition Mira's OWN chrome windows run on (the React UI: toolbar,
// sidebar, palette…). It exists to keep the chrome OUT of every profile session:
// the default profile's tabs live on the default Electron session, so a chrome
// window left on the default session would get extension content scripts (e.g.
// Dark Reader restyling the palette) injected into Mira's own UI. No web page and
// no extension ever loads in this partition.
//
// Consumers: profiles.ts (chrome BrowserWindow webPreferences) and index.ts
// (registers the crx: icon protocol on this session, since <browser-action-list>
// fetches its icons from the chrome).
export const CHROME_PARTITION = 'persist:mira-chrome'

/** Alias naming the DEFAULT Electron session in partition strings. Electron has
 * no partition name for the default session (fromPartition('') returns it, but
 * '' is dropped as falsy along the <browser-action-list> path, which then falls
 * back to the SENDER's session — the extension-free chrome one). loadRenderer
 * puts this alias in the chrome url for the default profile, and the resolver
 * installed in extensions.ts (setSessionPartitionResolver) maps it back to
 * session.defaultSession. */
export const DEFAULT_SESSION_ALIAS = 'mira-default-session'
