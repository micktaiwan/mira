// macOS Touch ID / Secure Enclave platform authenticator for WebAuthn.
//
// Until app.configureWebAuthn is called, isUserVerifyingPlatformAuthenticatorAvailable()
// resolves false and platform-authenticator requests (navigator.credentials.create/get)
// are not serviced — the symptom is a passkey prompt (e.g. Google's "Use your passkey to
// confirm it's really you") that never resolves and hangs the page forever.
//
// This is ONLY meaningful in the signed, packaged build. The keychainAccessGroup below
// must appear in the app's `keychain-access-groups` code-signing entitlement
// (build/entitlements.mac.plist), which is AMFI-restricted: it only takes effect when the
// bundle embeds a provisioning profile authorizing that group (build/embedded.provisionprofile,
// minted from the free personal team ZMKDR6H89Y). In `npm run dev` there is no entitlement,
// so we skip the call entirely.
//
// Note: Electron's Touch ID authenticator stores credentials in its OWN keychain access
// group, bound to this device's Secure Enclave — it does NOT see passkeys created elsewhere
// (Safari/Chrome/iCloud Keychain). So it authenticates passkeys CREATED in Mira, and enables
// registering new ones with Touch ID; it does not import a Google passkey made in another app.
//
// Docs: https://www.electronjs.org/docs/latest/api/app#appconfigurewebauthnoptions
import { app, session, type Session, type WebAuthnAccount } from 'electron'

// Keychain access group WebAuthn credentials are stored under. Format is
// <TEAM_ID>.<BUNDLE_ID>.webauthn (Electron TouchId docs). MUST stay in lockstep with the
// keychain-access-groups entitlement and the embedded provisioning profile's group.
export const WEBAUTHN_KEYCHAIN_GROUP = 'ZMKDR6H89Y.com.mickaelfm.mira.webauthn'

// Pure: pick which discoverable credential to assert with when macOS surfaces the device's
// stored passkeys for the relying party. One credential → use it; several → default to the
// first (a real account picker can come later); none → null, which cancels the request with
// NotAllowedError. Kept separate from the native wiring so it is unit-testable (CLAUDE.md
// "tout testable").
export function selectWebauthnAccount(accounts: Pick<WebAuthnAccount, 'credentialId'>[]): string | null {
  if (accounts.length === 0) return null
  return accounts[0].credentialId
}

// Attach the account-selection listener to a session. Electron cancels the credential request
// with NotAllowedError if NO listener is registered, so every session that can run a passkey
// flow needs this. The callback must be invoked exactly once.
function attachAccountSelection(ses: Session): void {
  ses.on('select-webauthn-account', (_event, details, callback) => {
    callback(selectWebauthnAccount(details.accounts))
  })
}

// Enable Touch ID for WebAuthn and wire account selection onto every session (the default one
// plus each profile partition as it is created). Safe no-op outside the packaged macOS build.
export function installTouchIdWebAuthn(): void {
  if (!app.isPackaged || process.platform !== 'darwin') return
  app.configureWebAuthn({
    touchID: {
      keychainAccessGroup: WEBAUTHN_KEYCHAIN_GROUP,
      promptReason: 'verify your identity on $1'
    }
  })
  attachAccountSelection(session.defaultSession)
  app.on('session-created', attachAccountSelection)
}
