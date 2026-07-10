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
// Policy (decided by Mickael): a personal browser trusted by its single user —
// grant EVERYTHING by default, no per-site prompt. What was actually granted is
// recorded (permission-store) and shown in Settings so the trust stays visible.

/** Single source of truth for both the permission CHECK and the permission
 * REQUEST handlers. `permission` is Electron's permission string (the two handlers
 * use slightly different unions, so this takes a plain string). Grant-all: always
 * true. Kept as a function so the policy has one home and the wiring stays testable
 * (a future allowlist / per-site rule only changes here). */
export function shouldGrantPermission(_permission: string): boolean {
  return true
}
