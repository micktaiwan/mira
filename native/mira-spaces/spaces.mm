// Mira spaces addon — macOS virtual desktops (Spaces), which Electron cannot see.
//
// macOS gives windows the same x/y on every Space, and relaunched apps always
// open their windows on the CURRENT Space: restoring a window's saved rectangle
// says nothing about which virtual desktop it lands on. There is no public API
// for per-window Space placement; the only handle is the private SkyLight (CGS)
// layer. Three facts, validated empirically on Darwin 25 (see docs/spaces.md):
//
//   1. SLSCopyManagedDisplaySpaces enumerates each display's Spaces in Mission
//      Control order, with the current one flagged — this is how an index like
//      "2nd desktop of display X" is computed (stable across relaunches, unlike
//      raw Space ids which change on reboot).
//   2. SLSCopySpacesForWindows reads the Space(s) a window is on.
//   3. SLSMoveWindowsToManagedSpace moves a window to a Space — it silently
//      works ONLY for windows owned by the calling process (locked down for
//      other processes' windows since macOS 14.5). Mira only ever moves its own
//      windows, so no SIP change or helper injection is needed.
//
// This file is thin wrappers only (raw data in/out, no decisions): the logic —
// indexing, display matching, restore policy — lives in src/main/spaces.ts where
// it is unit-tested, per the "tout testable" principle.
//
// Node-API C (node_api.h) is ABI-stable across Node/Electron, so this loads
// under Electron regardless of which headers it was built against.

#import <node_api.h>
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>

// Private SkyLight prototypes (no public header). CGDisplayGetDisplayIDFromUUID
// is exported by CoreGraphics but has no header in recent SDKs — declare it too.
extern "C" {
CGDirectDisplayID CGDisplayGetDisplayIDFromUUID(CFUUIDRef uuid);
int SLSMainConnectionID(void);
CFArrayRef SLSCopyManagedDisplaySpaces(int cid);
CFArrayRef SLSCopySpacesForWindows(int cid, int selector, CFArrayRef windowIDs);
void SLSMoveWindowsToManagedSpace(int cid, CFArrayRef windowIDs, uint64_t spaceID);
}

// Selector mask for SLSCopySpacesForWindows: all spaces the window belongs to.
static const int kSpacesForWindowsAll = 0x7;

static napi_value MakeDouble(napi_env env, double v) {
  napi_value out;
  napi_create_double(env, v, &out);
  return out;
}

/** "Display Identifier" from the managed-display dict is a UUID string, or the
 * literal "Main" for the primary display. Map it to the CGDirectDisplayID that
 * Electron exposes as Display.id, so the TS side can join the two worlds. */
static uint32_t DisplayIdFromIdentifier(NSString *identifier) {
  if (identifier == nil || [identifier isEqualToString:@"Main"]) return CGMainDisplayID();
  CFUUIDRef uuid = CFUUIDCreateFromString(kCFAllocatorDefault, (__bridge CFStringRef)identifier);
  if (uuid == NULL) return CGMainDisplayID();
  uint32_t displayId = CGDisplayGetDisplayIDFromUUID(uuid);
  CFRelease(uuid);
  // 0 = no such display (e.g. monitor unplugged since the snapshot).
  return displayId;
}

// spacesLayout(): every display's Spaces in Mission Control order.
// -> [{ displayId, currentSpaceId, spaces: [{ id, type }] }]
// type 0 = a user desktop, 4 = a fullscreen app's private Space.
static napi_value SpacesLayout(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value result;
  napi_create_array(env, &result);
  CFArrayRef displaysRef = SLSCopyManagedDisplaySpaces(SLSMainConnectionID());
  if (displaysRef == NULL) return result;
  NSArray *displays = (__bridge NSArray *)displaysRef;
  uint32_t outIndex = 0;
  for (NSDictionary *display in displays) {
    if (![display isKindOfClass:[NSDictionary class]]) continue;
    napi_value entry;
    napi_create_object(env, &entry);
    napi_set_named_property(
        env, entry, "displayId",
        MakeDouble(env, DisplayIdFromIdentifier(display[@"Display Identifier"])));
    NSNumber *current = display[@"Current Space"][@"ManagedSpaceID"];
    napi_set_named_property(env, entry, "currentSpaceId",
                            MakeDouble(env, current ? current.doubleValue : 0));
    napi_value spaces;
    napi_create_array(env, &spaces);
    uint32_t spaceIndex = 0;
    for (NSDictionary *space in display[@"Spaces"]) {
      if (![space isKindOfClass:[NSDictionary class]]) continue;
      NSNumber *spaceId = space[@"ManagedSpaceID"];
      NSNumber *type = space[@"type"];
      napi_value spaceEntry;
      napi_create_object(env, &spaceEntry);
      napi_set_named_property(env, spaceEntry, "id",
                              MakeDouble(env, spaceId ? spaceId.doubleValue : 0));
      napi_set_named_property(env, spaceEntry, "type",
                              MakeDouble(env, type ? type.doubleValue : 0));
      napi_set_element(env, spaces, spaceIndex++, spaceEntry);
    }
    napi_set_named_property(env, entry, "spaces", spaces);
    napi_set_element(env, result, outIndex++, entry);
  }
  CFRelease(displaysRef);
  return result;
}

/** Read the first (and only) number argument of a call, or -1 when absent. */
static double NumberArg(napi_env env, napi_callback_info info, size_t index, size_t expected) {
  napi_value args[2];
  size_t argc = expected;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc <= index) return -1;
  double v = -1;
  if (napi_get_value_double(env, args[index], &v) != napi_ok) return -1;
  return v;
}

// windowSpaces(windowNumber): ids of the Space(s) this window is on. Empty for a
// window the window server does not know (never shown, destroyed, bad id).
static napi_value WindowSpaces(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_create_array(env, &result);
  double wid = NumberArg(env, info, 0, 1);
  if (wid < 0) return result;
  NSArray *windowIds = @[ @((uint32_t)wid) ];
  CFArrayRef spacesRef = SLSCopySpacesForWindows(SLSMainConnectionID(), kSpacesForWindowsAll,
                                                 (__bridge CFArrayRef)windowIds);
  if (spacesRef == NULL) return result;
  NSArray *spaces = (__bridge NSArray *)spacesRef;
  uint32_t outIndex = 0;
  for (NSNumber *spaceId in spaces) {
    if (![spaceId isKindOfClass:[NSNumber class]]) continue;
    napi_set_element(env, result, outIndex++, MakeDouble(env, spaceId.doubleValue));
  }
  CFRelease(spacesRef);
  return result;
}

// moveWindowToSpace(windowNumber, spaceId): ask the window server to move one of
// OUR windows onto the given Space. Fire-and-forget (the call returns void); the
// TS side re-reads windowSpaces when it needs to verify.
static napi_value MoveWindowToSpace(napi_env env, napi_callback_info info) {
  double wid = NumberArg(env, info, 0, 2);
  double sid = NumberArg(env, info, 1, 2);
  napi_value out;
  napi_get_boolean(env, false, &out);
  if (wid < 0 || sid <= 0) return out;
  NSArray *windowIds = @[ @((uint32_t)wid) ];
  SLSMoveWindowsToManagedSpace(SLSMainConnectionID(), (__bridge CFArrayRef)windowIds,
                               (uint64_t)sid);
  napi_get_boolean(env, true, &out);
  return out;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fnLayout, fnWindowSpaces, fnMove;
  napi_create_function(env, "spacesLayout", NAPI_AUTO_LENGTH, SpacesLayout, NULL, &fnLayout);
  napi_set_named_property(env, exports, "spacesLayout", fnLayout);
  napi_create_function(env, "windowSpaces", NAPI_AUTO_LENGTH, WindowSpaces, NULL, &fnWindowSpaces);
  napi_set_named_property(env, exports, "windowSpaces", fnWindowSpaces);
  napi_create_function(env, "moveWindowToSpace", NAPI_AUTO_LENGTH, MoveWindowToSpace, NULL,
                       &fnMove);
  napi_set_named_property(env, exports, "moveWindowToSpace", fnMove);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
