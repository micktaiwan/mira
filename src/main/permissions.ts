// Permission policy for web content. Electron does NOT show Chromium's native
// "Allow this site to…?" bubble: a page's permission request is routed to the
// session's setPermissionRequestHandler / setPermissionCheckHandler instead, and
// if neither is set the CHECK returns denied by default — so geolocation (Google
// Maps, etc.) fails silently before any request is ever raised (see the note on
// electron.d.ts setPermissionRequestHandler: "most web APIs do a permission check
// and then make a permission request if the check is denied").
//
// This is the PURE decision layer (tested here); profiles.ts wires it onto each
// profile session (both handlers, so the check and the request agree).
//
// Policy (decided by the user): a personal browser trusted by its single user —
// grant everything by default, no per-site prompt, with two exceptions:
//   - 'clipboard-read' is DENIED (any page could otherwise silently read the
//     clipboard); writing the clipboard stays allowed;
//   - 'openExternal' (a page launching a custom-scheme handler, i.e. another app)
//     is granted only when the target URL's scheme is in OPEN_EXTERNAL_SCHEMES;
//     any other scheme, or a missing / unparsable URL, is denied.
// What was actually granted is recorded (permission-store) and shown in Settings
// so the trust stays visible.

/** Schemes a page may hand to the OS through 'openExternal' (lowercase, no colon). */
export const OPEN_EXTERNAL_SCHEMES: ReadonlySet<string> = new Set([
  'mailto',
  'tel',
  'sms',
  'facetime',
  'facetime-audio',
  'zoommtg',
  'zoomus',
  'slack',
  'msteams'
])

/** Request details the policy looks at. Only the REQUEST handler carries
 * `externalURL` (for 'openExternal'); the CHECK handler has none. */
export interface PermissionDetails {
  externalURL?: string
}

/** Scheme of `url`, lowercase and without the colon, or null if unparsable. */
function schemeOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).protocol.replace(/:$/, '').toLowerCase()
  } catch {
    return null
  }
}

/** Single source of truth for both the permission CHECK and the permission
 * REQUEST handlers. `permission` is Electron's permission string (the two handlers
 * use slightly different unions, so this takes a plain string). Pure. */
export function shouldGrantPermission(permission: string, details?: PermissionDetails): boolean {
  // The deprecated sync read is inert today (enableDeprecatedPaste is off) but
  // reads the same clipboard, so it shares the rule.
  if (permission === 'clipboard-read' || permission === 'deprecated-sync-clipboard-read')
    return false
  if (permission === 'openExternal') {
    const scheme = schemeOf(details?.externalURL)
    return scheme !== null && OPEN_EXTERNAL_SCHEMES.has(scheme)
  }
  return true
}
