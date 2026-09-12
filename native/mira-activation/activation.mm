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

// Optional JS observer, called on EVERY programmatic activation attempt —
// suppressed or not. It exists because a pass-through left no trace: when Mira
// jumped in front of the user, nothing in the app had recorded that it happened,
// so every investigation after the fact could only read the code and conclude
// "I see nothing that does this". The observer turns that into evidence — and its
// JS stack is the discriminator: frames of ours mean OUR code asked for the
// foreground, an empty stack means Chromium did it from C++.
static napi_env gObserverEnv = NULL;
static napi_ref gObserverRef = NULL;
// Reentrancy guard: the observer runs JS, and that JS could itself end up in
// -[NSApplication activate]. Never call the observer from inside the observer.
static BOOL gInObserver = NO;

// Call the JS observer with (suppressed, ignoringOtherApps). Runs on the AppKit
// main thread, which is the Electron main process's Node thread, so a direct
// synchronous call is safe. Silent no-op when no observer is registered.
static void NotifyObserver(BOOL suppressed, BOOL ignoring) {
  if (!gObserverEnv || !gObserverRef || gInObserver) return;
  gInObserver = YES;
  napi_handle_scope scope;
  if (napi_open_handle_scope(gObserverEnv, &scope) == napi_ok) {
    napi_value fn, global, argv[2], result;
    if (napi_get_reference_value(gObserverEnv, gObserverRef, &fn) == napi_ok && fn) {
      napi_get_global(gObserverEnv, &global);
      napi_get_boolean(gObserverEnv, suppressed, &argv[0]);
      napi_get_boolean(gObserverEnv, ignoring, &argv[1]);
      napi_call_function(gObserverEnv, global, fn, 2, argv, &result);
      // Swallow a throwing observer: diagnostics must never break activation.
      bool pending = false;
      napi_is_exception_pending(gObserverEnv, &pending);
      if (pending) {
        napi_value ignored;
        napi_get_and_clear_last_exception(gObserverEnv, &ignored);
      }
    }
    napi_close_handle_scope(gObserverEnv, scope);
  }
  gInObserver = NO;
}

// Saved original implementations, called through when not suppressing.
static void (*gOrigActivate)(id, SEL) = NULL;              // -[NSApplication activate] (macOS 14+)
static void (*gOrigActivateIgnoring)(id, SEL, BOOL) = NULL; // -[NSApplication activateIgnoringOtherApps:]

static void SwizzledActivate(id self, SEL _cmd) {
  NotifyObserver(gSuppressActivation, NO);
  if (gSuppressActivation) return;
  if (gOrigActivate) gOrigActivate(self, _cmd);
}

static void SwizzledActivateIgnoring(id self, SEL _cmd, BOOL flag) {
  NotifyObserver(gSuppressActivation, flag);
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

// setActivationObserver(fn | null): register (or clear) the JS observer called on
// every activation attempt. Replacing an existing observer releases the old one.
static napi_value SetActivationObserver(napi_env env, napi_callback_info info) {
  napi_value args[1];
  size_t argc = 1;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (gObserverRef) {
    napi_delete_reference(gObserverEnv, gObserverRef);
    gObserverRef = NULL;
    gObserverEnv = NULL;
  }
  napi_valuetype type = napi_undefined;
  if (argc >= 1) napi_typeof(env, args[0], &type);
  if (type == napi_function) {
    gObserverEnv = env;
    napi_create_reference(env, args[0], 1, &gObserverRef);
  }
  napi_value out;
  napi_get_boolean(env, gObserverRef != NULL, &out);
  return out;
}

static napi_value Init(napi_env env, napi_value exports) {
  InstallSwizzle();
  napi_value fnSet;
  napi_create_function(env, "setSuppressActivation", NAPI_AUTO_LENGTH, SetSuppressActivation, NULL,
                       &fnSet);
  napi_set_named_property(env, exports, "setSuppressActivation", fnSet);
  napi_value fnObserve;
  napi_create_function(env, "setActivationObserver", NAPI_AUTO_LENGTH, SetActivationObserver, NULL,
                       &fnObserve);
  napi_set_named_property(env, exports, "setActivationObserver", fnObserve);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
