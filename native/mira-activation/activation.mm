// Mira activation addon — stop a background WebContentsView from dragging the
// whole app to the foreground on macOS.
//
// The problem (measured, see the focus timeline in git history / discussion):
// when a page reloads itself (dev-server HMR full reload, meta-refresh, JS
// redirect), Chromium restores focus to the renderer widget on the navigation
// commit and ACTIVATES the app — ~25 ms after commit — even while Mira sits in
// the background behind the user's editor. Real browsers don't do this for a
// background tab, so it is a genuine defect.
//
// Why this can only be fixed natively: the activation is Chromium-internal for an
// embedded WebContentsView. Electron exposes no lever — `focusOnNavigation`
// only gates the KEYBOARD focus of top-level `kBrowserWindow` contents (no-op for
// our embedded views), and `win.setFocusable(false)` merely DEFERS the
// activation until the window is focusable again, it does not cancel it.
//
// The fix: the app is brought forward by Chromium calling `-[NSApplication
// activate]` / `activateIgnoringOtherApps:` on OUR application object. We swizzle
// those two methods so they no-op while a "suppress" flag is set. The flag is
// armed by the TS side (src/main/profiles.ts) for a short window around a
// BACKGROUND navigation commit, and cleared right after.
//
// Crucially this only swallows PROGRAMMATIC self-activation. A user activating
// the app — Cmd-Tab, dock click, clicking a window — is delivered by the window
// server as `applicationDidBecomeActive`, it does NOT go through our `activate`
// call, so it is never blocked. That is exactly the line we want to draw.
//
// Node-API C (node_api.h) is ABI-stable across Node/Electron, so this loads under
// Electron regardless of which headers it was built against.

#import <node_api.h>
#import <AppKit/AppKit.h>
#import <objc/runtime.h>

// Toggled from the main thread (Electron main = AppKit main thread); the swizzled
// methods also run on the main thread, so a plain BOOL needs no synchronization.
static BOOL gSuppressActivation = NO;

// Saved original implementations, called through when not suppressing.
static void (*gOrigActivate)(id, SEL) = NULL;              // -[NSApplication activate] (macOS 14+)
static void (*gOrigActivateIgnoring)(id, SEL, BOOL) = NULL; // -[NSApplication activateIgnoringOtherApps:]

static void SwizzledActivate(id self, SEL _cmd) {
  if (gSuppressActivation) return;
  if (gOrigActivate) gOrigActivate(self, _cmd);
}

static void SwizzledActivateIgnoring(id self, SEL _cmd, BOOL flag) {
  if (gSuppressActivation) return;
  if (gOrigActivateIgnoring) gOrigActivateIgnoring(self, _cmd, flag);
}

// Install the swizzle once, at module load. It stays permanently installed but is
// inert (passes straight through) whenever gSuppressActivation is NO, so normal
// activation is untouched — only an armed suppression window changes behaviour.
static void InstallSwizzle(void) {
  static BOOL installed = NO;
  if (installed) return;
  installed = YES;
  Class cls = [NSApplication class];

  SEL selIgnoring = @selector(activateIgnoringOtherApps:);
  Method mIgnoring = class_getInstanceMethod(cls, selIgnoring);
  if (mIgnoring) {
    gOrigActivateIgnoring = (void (*)(id, SEL, BOOL))method_getImplementation(mIgnoring);
    method_setImplementation(mIgnoring, (IMP)SwizzledActivateIgnoring);
  }

  // -[NSApplication activate] exists since macOS 14; guard so we don't create a
  // bogus method on older systems.
  SEL selActivate = @selector(activate);
  Method mActivate = class_getInstanceMethod(cls, selActivate);
  if (mActivate) {
    gOrigActivate = (void (*)(id, SEL))method_getImplementation(mActivate);
    method_setImplementation(mActivate, (IMP)SwizzledActivate);
  }
}

// setSuppressActivation(on: boolean): arm / disarm the suppression flag.
static napi_value SetSuppressActivation(napi_env env, napi_callback_info info) {
  napi_value args[1];
  size_t argc = 1;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  bool on = false;
  if (argc >= 1) napi_get_value_bool(env, args[0], &on);
  gSuppressActivation = on ? YES : NO;
  napi_value out;
  napi_get_boolean(env, gSuppressActivation, &out);
  return out;
}

static napi_value Init(napi_env env, napi_value exports) {
  InstallSwizzle();
  napi_value fnSet;
  napi_create_function(env, "setSuppressActivation", NAPI_AUTO_LENGTH, SetSuppressActivation, NULL,
                       &fnSet);
  napi_set_named_property(env, exports, "setSuppressActivation", fnSet);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
