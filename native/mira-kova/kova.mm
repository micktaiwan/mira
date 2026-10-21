// Mira Kova addon — one Kova terminal pane embedded in a Mira window.
//
// Kova (a native macOS terminal) ships its terminal as a library: libkova.a, a
// Rust staticlib with a C API (kova/include/kova.h). A pane is a shell in a PTY
// plus Kova's terminal state; created with a parent NSView, the library adds its
// own subview that takes AppKit input itself (keys, IME, mouse, scroll, copy and
// paste) and draws into its own CAMetalLayer. This addon links that library
// statically and exposes a handful of thin wrappers to the main process.
//
// Nothing runs on its own: the host drives the clock. tickAll() is meant to be
// called from a ~60 Hz timer in the main process; it ticks every pane, draws
// those that need it and answers the Kova socket once.
//
// Threading: every kova_* call must run on the AppKit main thread. Electron's
// main-process JS thread IS that thread, so calling these functions from main
// JS is correct; never call them from a worker.
//
// This file is thin wrappers only (raw data in/out, no decisions): when to
// create, place, show, focus or free a pane lives on the TS side, per the
// "everything testable" principle. Every function validates its arguments and
// returns false / 0 / null on bad input or an unknown pane; none throws.
//
// Node-API C (node_api.h) is ABI-stable across Node/Electron, so this loads
// under Electron regardless of which headers it was built against (and under
// plain node too, which is what smoke.mjs relies on).

#import <node_api.h>
#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>

#include <stdint.h>
#include <stdlib.h>
#include <cmath>
#include <set>
#include <string>
#include <vector>

// Mirrors kova/include/kova.h; keep in sync. Only what this addon uses.
extern "C" {
typedef uint32_t KovaPaneId;

typedef struct KovaPaneOptions {
  void *parent_view;
  const char *cwd;
  const char *command;
  const char *const *env;
  uint16_t cols;
  uint16_t rows;
} KovaPaneOptions;

void kova_string_free(char *s);
KovaPaneId kova_pane_new(const KovaPaneOptions *options);
int kova_pane_free(KovaPaneId pane);
int kova_shutdown(void);
void *kova_pane_view(KovaPaneId pane);
int kova_pane_set_frame(KovaPaneId pane, double x, double y, double width, double height);
uint32_t kova_pane_tick(KovaPaneId pane);
int kova_pane_draw(KovaPaneId pane, int force);
int kova_pane_text(KovaPaneId pane, const char *utf8);
int kova_pane_paste(KovaPaneId pane, const char *utf8);
char *kova_pane_copy_text(KovaPaneId pane, int mode, int trim_trailing_blank_lines);
int kova_pane_is_alive(KovaPaneId pane);
int kova_ipc_start(const char *path);
int kova_ipc_poll(void);
int kova_ipc_stop(void);
}

#define KOVA_EVENT_EXITED (1u << 1)
#define KOVA_EVENT_NEEDS_DRAW (1u << 5)
#define KOVA_TEXT_ALL 2

// Live pane ids created through this addon. Only these are ever handed to kova_*
// calls, so a stale or made-up id from JS is rejected here.
static std::set<KovaPaneId> gPanes;

// ipcStart is idempotent: 0 = not called yet, 1 = started, -1 = failed.
static int gIpcState = 0;

// ── Argument helpers ────────────────────────────────────────────────────────

static napi_value Bool(napi_env env, bool v) {
  napi_value out;
  napi_get_boolean(env, v, &out);
  return out;
}

static napi_value Null(napi_env env) {
  napi_value out;
  napi_get_null(env, &out);
  return out;
}

static napi_value Number(napi_env env, double v) {
  napi_value out;
  napi_create_double(env, v, &out);
  return out;
}

/** Read up to `max` arguments; returns how many were passed. */
static size_t Args(napi_env env, napi_callback_info info, napi_value *args, size_t max) {
  size_t argc = max;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok) return 0;
  return argc;
}

static bool IsType(napi_env env, napi_value v, napi_valuetype want) {
  napi_valuetype t;
  if (napi_typeof(env, v, &t) != napi_ok) return false;
  return t == want;
}

static bool GetDouble(napi_env env, napi_value v, double *out) {
  if (!IsType(env, v, napi_number)) return false;
  return napi_get_value_double(env, v, out) == napi_ok;
}

static bool GetString(napi_env env, napi_value v, std::string *out) {
  if (!IsType(env, v, napi_string)) return false;
  size_t len = 0;
  if (napi_get_value_string_utf8(env, v, NULL, 0, &len) != napi_ok) return false;
  std::string s(len, '\0');
  if (napi_get_value_string_utf8(env, v, &s[0], len + 1, &len) != napi_ok) return false;
  s.resize(len);
  *out = s;
  return true;
}

/** A tracked pane id from argument `index`, or 0. */
static KovaPaneId PaneArg(napi_env env, napi_value *args, size_t argc, size_t index) {
  if (argc <= index) return 0;
  double d = 0;
  if (!GetDouble(env, args[index], &d)) return 0;
  if (d < 1 || d > UINT32_MAX || d != (double)(uint32_t)d) return 0;
  KovaPaneId id = (KovaPaneId)d;
  return gPanes.count(id) ? id : 0;
}

static NSView *PaneView(KovaPaneId id) { return (NSView *)kova_pane_view(id); }

// ── Exports ─────────────────────────────────────────────────────────────────

// ipcStart(): serve Kova's socket at /tmp/kova-<pid>.sock. Must run before the
// first paneNew so the shells' KOVA_SOCKET points to a served socket.
static napi_value IpcStart(napi_env env, napi_callback_info info) {
  (void)info;
  if (gIpcState == 0) gIpcState = kova_ipc_start(NULL) == 0 ? 1 : -1;
  return Bool(env, gIpcState == 1);
}

// ipcStop(): stop serving the socket and remove its file (once the last pane is
// gone, so Kova clients do not find a socket nobody answers). A later ipcStart
// serves it again.
static napi_value IpcStop(napi_env env, napi_callback_info info) {
  (void)info;
  if (gIpcState == 1) kova_ipc_stop();
  gIpcState = 0;
  napi_value undef;
  napi_get_undefined(env, &undef);
  return undef;
}

// paneNew(windowNumber, { cwd?, command?, env? }): a new pane. windowNumber > 0
// puts its view in that window's contentView, hidden right away (until the TS
// side sets a frame and shows it, it would cover the whole window); 0 makes a
// pane without view. -> pane id, 0 on failure.
static napi_value PaneNew(napi_env env, napi_callback_info info) {
  napi_value args[2];
  size_t argc = Args(env, info, args, 2);
  double wn = -1;
  if (argc < 1 || !GetDouble(env, args[0], &wn) || wn < 0 || wn != (double)(NSInteger)wn) {
    return Number(env, 0);
  }

  std::string cwd, command;
  bool hasCwd = false, hasCommand = false;
  std::vector<std::string> envStrings;
  if (argc >= 2 && IsType(env, args[1], napi_object)) {
    napi_value v;
    bool has = false;
    if (napi_has_named_property(env, args[1], "cwd", &has) == napi_ok && has &&
        napi_get_named_property(env, args[1], "cwd", &v) == napi_ok) {
      hasCwd = GetString(env, v, &cwd) && !cwd.empty();
    }
    if (napi_has_named_property(env, args[1], "command", &has) == napi_ok && has &&
        napi_get_named_property(env, args[1], "command", &v) == napi_ok) {
      hasCommand = GetString(env, v, &command) && !command.empty();
    }
    if (napi_has_named_property(env, args[1], "env", &has) == napi_ok && has &&
        napi_get_named_property(env, args[1], "env", &v) == napi_ok) {
      bool isArray = false;
      if (napi_is_array(env, v, &isArray) == napi_ok && isArray) {
        uint32_t n = 0;
        napi_get_array_length(env, v, &n);
        for (uint32_t i = 0; i < n; i++) {
          napi_value item;
          std::string s;
          if (napi_get_element(env, v, i, &item) != napi_ok) continue;
          // Only NAME=value strings: anything else is dropped, not passed on.
          if (GetString(env, item, &s) && s.find('=') != std::string::npos && s[0] != '=') {
            envStrings.push_back(s);
          }
        }
      }
    }
  }

  NSView *parent = nil;
  if (wn > 0) {
    if (NSApp == nil) return Number(env, 0);
    NSWindow *window = [NSApp windowWithWindowNumber:(NSInteger)wn];
    if (window == nil) return Number(env, 0);
    parent = [window contentView];
    if (parent == nil) return Number(env, 0);
  }

  std::vector<const char *> envPtrs;
  for (const std::string &s : envStrings) envPtrs.push_back(s.c_str());
  envPtrs.push_back(NULL);

  KovaPaneOptions opts = {};
  opts.parent_view = (void *)parent;
  opts.cwd = hasCwd ? cwd.c_str() : NULL;
  opts.command = hasCommand ? command.c_str() : NULL;
  opts.env = envStrings.empty() ? NULL : envPtrs.data();

  KovaPaneId id = kova_pane_new(&opts);
  if (id == 0) return Number(env, 0);
  gPanes.insert(id);
  NSView *view = PaneView(id);
  if (view != nil) [view setHidden:YES];
  return Number(env, id);
}

// paneSetFrame(id, x, y, w, h): place the view, in points, top-left origin,
// relative to the window's contentView (the DOM convention). AppKit views are
// bottom-left unless flipped, so y is converted here.
static napi_value PaneSetFrame(napi_env env, napi_callback_info info) {
  napi_value args[5];
  size_t argc = Args(env, info, args, 5);
  KovaPaneId id = PaneArg(env, args, argc, 0);
  if (id == 0 || argc < 5) return Bool(env, false);
  double r[4];
  for (int i = 0; i < 4; i++) {
    if (!GetDouble(env, args[i + 1], &r[i]) || !std::isfinite(r[i])) return Bool(env, false);
  }
  if (r[2] < 0 || r[3] < 0) return Bool(env, false);
  NSView *view = PaneView(id);
  if (view == nil) return Bool(env, false);
  NSView *parent = [view superview];
  double y = r[1];
  if (parent != nil && ![parent isFlipped]) y = parent.bounds.size.height - r[1] - r[3];
  return Bool(env, kova_pane_set_frame(id, r[0], y, r[2], r[3]) == 0);
}

// paneSetHidden(id, hidden): Kova has no hide call; hide the NSView itself.
static napi_value PaneSetHidden(napi_env env, napi_callback_info info) {
  napi_value args[2];
  size_t argc = Args(env, info, args, 2);
  KovaPaneId id = PaneArg(env, args, argc, 0);
  if (id == 0 || argc < 2 || !IsType(env, args[1], napi_boolean)) return Bool(env, false);
  bool hidden = false;
  napi_get_value_bool(env, args[1], &hidden);
  NSView *view = PaneView(id);
  if (view == nil) return Bool(env, false);
  [view setHidden:hidden ? YES : NO];
  return Bool(env, true);
}

// paneFocus(id): make the pane's view the first responder of its window.
static napi_value PaneFocus(napi_env env, napi_callback_info info) {
  napi_value args[1];
  size_t argc = Args(env, info, args, 1);
  KovaPaneId id = PaneArg(env, args, argc, 0);
  if (id == 0) return Bool(env, false);
  NSView *view = PaneView(id);
  NSWindow *window = view != nil ? [view window] : nil;
  if (window == nil) return Bool(env, false);
  return Bool(env, [window makeFirstResponder:view] == YES);
}

// paneIsFocused(id): the pane's view (or one of its subviews) is the first
// responder of its window, i.e. it holds the keyboard.
static napi_value PaneIsFocused(napi_env env, napi_callback_info info) {
  napi_value args[1];
  size_t argc = Args(env, info, args, 1);
  KovaPaneId id = PaneArg(env, args, argc, 0);
  if (id == 0) return Bool(env, false);
  NSView *view = PaneView(id);
  NSWindow *window = view != nil ? [view window] : nil;
  if (window == nil || [view isHidden]) return Bool(env, false);
  NSResponder *responder = [window firstResponder];
  if (![responder isKindOfClass:[NSView class]]) return Bool(env, false);
  return Bool(env, [(NSView *)responder isDescendantOf:view] == YES);
}

/** Shared body of panePaste / paneText: (id, string) -> kova call == 0. */
static napi_value PaneWrite(napi_env env, napi_callback_info info,
                            int (*fn)(KovaPaneId, const char *)) {
  napi_value args[2];
  size_t argc = Args(env, info, args, 2);
  KovaPaneId id = PaneArg(env, args, argc, 0);
  std::string text;
  if (id == 0 || argc < 2 || !GetString(env, args[1], &text)) return Bool(env, false);
  return Bool(env, fn(id, text.c_str()) == 0);
}

// panePaste(id, text): a paste (bracketed when the app in the pane asked for it).
static napi_value PanePaste(napi_env env, napi_callback_info info) {
  return PaneWrite(env, info, kova_pane_paste);
}

// paneText(id, text): raw bytes to the PTY ("\r" = Enter).
static napi_value PaneText(napi_env env, napi_callback_info info) {
  return PaneWrite(env, info, kova_pane_text);
}

// paneIsAlive(id): the pane's shell still runs.
static napi_value PaneIsAlive(napi_env env, napi_callback_info info) {
  napi_value args[1];
  size_t argc = Args(env, info, args, 1);
  KovaPaneId id = PaneArg(env, args, argc, 0);
  if (id == 0) return Bool(env, false);
  return Bool(env, kova_pane_is_alive(id) == 1);
}

// paneCopyText(id): scrollback then screen, trailing blank lines trimmed.
static napi_value PaneCopyText(napi_env env, napi_callback_info info) {
  napi_value args[1];
  size_t argc = Args(env, info, args, 1);
  KovaPaneId id = PaneArg(env, args, argc, 0);
  if (id == 0) return Null(env);
  char *text = kova_pane_copy_text(id, KOVA_TEXT_ALL, 1);
  if (text == NULL) return Null(env);
  napi_value out;
  napi_status st = napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &out);
  kova_string_free(text);
  return st == napi_ok ? out : Null(env);
}

// tickAll(): one frame for every pane (tick, draw if needed), then answer the
// socket once. -> ids whose shell exited during this tick.
static napi_value TickAll(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value exited;
  napi_create_array(env, &exited);
  uint32_t n = 0;
  // Copy: nothing below mutates gPanes, but keep iteration safe regardless.
  std::vector<KovaPaneId> ids(gPanes.begin(), gPanes.end());
  for (KovaPaneId id : ids) {
    uint32_t ev = kova_pane_tick(id);
    if (ev & KOVA_EVENT_NEEDS_DRAW) kova_pane_draw(id, 0);
    if (ev & KOVA_EVENT_EXITED) napi_set_element(env, exited, n++, Number(env, id));
  }
  kova_ipc_poll();
  return exited;
}

// paneFree(id): close the pane (non-blocking; its processes are reaped in the
// background) and stop tracking it.
static napi_value PaneFree(napi_env env, napi_callback_info info) {
  napi_value args[1];
  size_t argc = Args(env, info, args, 1);
  KovaPaneId id = PaneArg(env, args, argc, 0);
  if (id == 0) return Bool(env, false);
  gPanes.erase(id);
  return Bool(env, kova_pane_free(id) == 0);
}

// shutdown(): free every pane, stop the socket, and block (about 2 s at most)
// until their processes are gone. For app quit.
static napi_value Shutdown(napi_env env, napi_callback_info info) {
  (void)info;
  kova_shutdown();
  gPanes.clear();
  gIpcState = 0;
  napi_value undef;
  napi_get_undefined(env, &undef);
  return undef;
}

static void Export(napi_env env, napi_value exports, const char *name, napi_callback cb) {
  napi_value fn;
  napi_create_function(env, name, NAPI_AUTO_LENGTH, cb, NULL, &fn);
  napi_set_named_property(env, exports, name, fn);
}

static napi_value Init(napi_env env, napi_value exports) {
  Export(env, exports, "ipcStart", IpcStart);
  Export(env, exports, "ipcStop", IpcStop);
  Export(env, exports, "paneNew", PaneNew);
  Export(env, exports, "paneSetFrame", PaneSetFrame);
  Export(env, exports, "paneSetHidden", PaneSetHidden);
  Export(env, exports, "paneFocus", PaneFocus);
  Export(env, exports, "paneIsFocused", PaneIsFocused);
  Export(env, exports, "panePaste", PanePaste);
  Export(env, exports, "paneText", PaneText);
  Export(env, exports, "paneIsAlive", PaneIsAlive);
  Export(env, exports, "paneCopyText", PaneCopyText);
  Export(env, exports, "tickAll", TickAll);
  Export(env, exports, "paneFree", PaneFree);
  Export(env, exports, "shutdown", Shutdown);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
