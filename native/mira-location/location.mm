// Mira location addon — the one thing Electron cannot do on macOS.
//
// Electron's bundled Chromium reads position from CoreLocation but never calls
// -[CLLocationManager requestWhenInUseAuthorization], so on a not-yet-authorized
// app the geolocation request silently hangs and no system prompt appears (the
// browser-layer //components/permissions bridge that Chrome ships is not compiled
// into Electron). This addon supplies the two missing primitives, IN Mira's own
// process, so the CLLocationManager runs under Mira's bundle id (com.mira.app):
//
//   authorizationStatus() -> 'authorized' | 'denied' | 'restricted' | 'not-determined'
//   requestAuthorization() -> same, after firing the native prompt when undetermined
//
// requestAuthorization() shows the real "Mira would like to use your location"
// prompt; on Allow, macOS ticks Location Services for com.mira.app and Chromium
// (same identity) then serves the fix. authorizationStatus() lets the main process
// decide to prompt / open Settings / do nothing based on the REAL state, so it
// never nags when location already works.
//
// Node-API C (node_api.h) is ABI-stable across Node/Electron, so this loads under
// Electron 41 regardless of which headers it was built against.

#import <node_api.h>
#import <CoreLocation/CoreLocation.h>

// A minimal delegate. We do not store the status here — CLLocationManager's
// instance `authorizationStatus` is the source of truth — but a live delegate on a
// retained manager keeps CoreLocation active and lets the authorization callback
// fire, which is required for the prompt to be delivered reliably.
@interface MiraLocationDelegate : NSObject <CLLocationManagerDelegate>
@end

@implementation MiraLocationDelegate
- (void)locationManagerDidChangeAuthorization:(CLLocationManager *)manager {
  // Intentionally empty: the value is read on demand from manager.authorizationStatus.
  (void)manager;
}
@end

// Retained for the whole process lifetime. A CLLocationManager that is created and
// released immediately is a well-known footgun (the prompt/callback may never
// arrive); keeping it (and its delegate) alive avoids that.
static CLLocationManager *gManager = nil;
static MiraLocationDelegate *gDelegate = nil;

static void EnsureManager() {
  if (gManager != nil) return;
  gDelegate = [[MiraLocationDelegate alloc] init];
  gManager = [[CLLocationManager alloc] init];
  gManager.delegate = gDelegate;
}

static const char *StatusString(CLAuthorizationStatus status) {
  // Compared by integer value on purpose: kCLAuthorizationStatusAuthorizedWhenInUse
  // (raw 4) is marked API_UNAVAILABLE(macos), so we cannot name the symbol — yet
  // requestWhenInUseAuthorization CAN produce it at runtime. Treating both Always
  // (3) and 4 as "authorized" is exactly the mapping node-mac-permissions gets
  // wrong (it omits 4, so a working app reads back as not-determined).
  switch ((int)status) {
    case kCLAuthorizationStatusAuthorizedAlways:  // 3
    case 4:                                        // AuthorizedWhenInUse, by value
      return "authorized";
    case kCLAuthorizationStatusDenied:             // 2
      return "denied";
    case kCLAuthorizationStatusRestricted:         // 1
      return "restricted";
    case kCLAuthorizationStatusNotDetermined:      // 0
    default:
      return "not-determined";
  }
}

static CLAuthorizationStatus CurrentStatus() {
  EnsureManager();
  if (@available(macOS 11.0, *)) {
    return gManager.authorizationStatus;
  }
  return [CLLocationManager authorizationStatus];
}

static napi_value MakeString(napi_env env, const char *s) {
  napi_value out;
  napi_create_string_utf8(env, s, NAPI_AUTO_LENGTH, &out);
  return out;
}

// authorizationStatus(): read the current macOS location authorization for Mira.
static napi_value AuthorizationStatus(napi_env env, napi_callback_info info) {
  (void)info;
  return MakeString(env, StatusString(CurrentStatus()));
}

// requestAuthorization(): fire the native prompt when undetermined, then return the
// (possibly still-pending) status. The prompt is async — the definitive result
// arrives later and is read via authorizationStatus() on the next attempt.
static napi_value RequestAuthorization(napi_env env, napi_callback_info info) {
  (void)info;
  EnsureManager();
  if (CurrentStatus() == kCLAuthorizationStatusNotDetermined) {
    [gManager requestWhenInUseAuthorization];
  }
  return MakeString(env, StatusString(CurrentStatus()));
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fnStatus, fnRequest;
  napi_create_function(env, "authorizationStatus", NAPI_AUTO_LENGTH, AuthorizationStatus, NULL,
                       &fnStatus);
  napi_set_named_property(env, exports, "authorizationStatus", fnStatus);
  napi_create_function(env, "requestAuthorization", NAPI_AUTO_LENGTH, RequestAuthorization, NULL,
                       &fnRequest);
  napi_set_named_property(env, exports, "requestAuthorization", fnRequest);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
