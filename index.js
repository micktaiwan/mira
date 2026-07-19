"use strict";
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");
const electron = require("electron");
const url = require("url");
const utils = require("@electron-toolkit/utils");
const os = require("node:os");
const node_path = require("node:path");
const node_crypto = require("node:crypto");
const node_child_process = require("node:child_process");
const node_fs = require("node:fs");
const node_url = require("node:url");
const net = require("net");
const crypto = require("crypto");
const promises = require("node:fs/promises");
const child_process = require("child_process");
const module$1 = require("module");
const electronChromeExtensions = require("electron-chrome-extensions");
const electronChromeWebStore = require("electron-chrome-web-store");
if (!process.env.DEBUG) {
  process.env.DEBUG = "electron-chrome-extensions:*,electron-chrome-web-store:*";
}
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_TAIL_BYTES = 10 * 1024 * 1024;
function logTimestamp(at) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`;
}
function logFileName(kind, at) {
  return `${kind}-${logTimestamp(at)}.log`;
}
function timeKey(name) {
  return name.replace(/^[a-z]+-/, "");
}
function archivesToPrune(entries, budget) {
  const archives = entries.filter((e) => e.name.endsWith(".log.gz")).sort((a, b) => timeKey(b.name).localeCompare(timeKey(a.name)));
  const doomed = [];
  let total = 0;
  archives.forEach((e, i) => {
    total += e.size;
    if (i > 0 && total > budget) doomed.push(e.name);
  });
  return doomed;
}
function archiveLog(logsDir, name) {
  const path$1 = path.join(logsDir, name);
  const size = fs.statSync(path$1).size;
  const start = Math.max(0, size - MAX_TAIL_BYTES);
  const buf = Buffer.alloc(size - start);
  const fd = fs.openSync(path$1, "r");
  try {
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  fs.writeFileSync(`${path$1}.gz`, zlib.gzipSync(buf));
  fs.rmSync(path$1);
}
function initLogging(userDataDir, now = /* @__PURE__ */ new Date()) {
  const logsDir = path.join(userDataDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  for (const name of fs.readdirSync(logsDir)) {
    if (!name.endsWith(".log")) continue;
    try {
      archiveLog(logsDir, name);
    } catch {
    }
  }
  try {
    const entries = fs.readdirSync(logsDir).map((name) => ({
      name,
      size: fs.statSync(path.join(logsDir, name)).size
    }));
    for (const name of archivesToPrune(entries, MAX_ARCHIVE_BYTES)) {
      fs.rmSync(path.join(logsDir, name));
    }
  } catch {
  }
  const mainLog = path.join(logsDir, logFileName("main", now));
  const chromiumLog = path.join(logsDir, logFileName("chromium", now));
  electron.app.commandLine.appendSwitch("enable-logging", "file");
  electron.app.commandLine.appendSwitch("log-file", chromiumLog);
  let writing = false;
  const tee = (stream) => {
    const original = stream.write.bind(stream);
    stream.write = ((chunk, ...rest) => {
      if (!writing) {
        writing = true;
        try {
          const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
          fs.appendFileSync(mainLog, `${(/* @__PURE__ */ new Date()).toISOString()} ${text}`);
        } catch {
        }
        writing = false;
      }
      return original(chunk, ...rest);
    });
  };
  tee(process.stdout);
  tee(process.stderr);
  process.on("uncaughtException", (error) => {
    console.error("[mira] uncaught exception:", error);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[mira] unhandled rejection:", reason);
  });
  return { logsDir, mainLog, chromiumLog };
}
const icon = path.join(__dirname, "../../resources/icon.png");
function fail(error) {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}
function buildRegistry(commands) {
  const all = { ...commands };
  all["list-commands"] = () => ({ ok: true, commands: Object.keys(all).sort() });
  return {
    // `execute` is typed as returning a synchronous CommandResult so the many
    // sync callers/tests stay ergonomic. A handful of handlers are async
    // (import-cookies), so the runtime value may actually be a Promise — the
    // transports that can hit those (socket, IPC) await the result, which is a
    // no-op on a plain object. The cast localizes that imprecision here.
    execute(name, params, ctx) {
      const handler = all[name];
      if (!handler) throw new Error(`Unknown command: ${name}`);
      return handler(ctx, params);
    },
    has(name) {
      return name in all;
    },
    names() {
      return Object.keys(all);
    }
  };
}
const appCommands = {
  "focus-app": (ctx) => {
    try {
      ctx.focusApp();
      return { ok: true };
    } catch (error) {
      return fail(error);
    }
  }
};
const audioCommands = {
  // The toolbar audio button: pop the native menu listing this window's audible
  // tabs. The native popup appears at the cursor and composites above the
  // WebContentsView.
  "show-audio-menu": (ctx) => {
    try {
      ctx.showAudioMenu();
      return { ok: true };
    } catch (error) {
      return fail(error);
    }
  }
};
const bookmarksCommands = {
  // Cmd+D / the star / the socket: bookmark a page. With no url, saves the active
  // tab; parentId targets a folder (default: top level).
  "add-bookmark": (ctx, params) => {
    const { url: url2, title, parentId } = params ?? {};
    if (url2 !== void 0 && (typeof url2 !== "string" || url2.trim() === "")) {
      return { ok: false, error: '"url" must be a non-empty string' };
    }
    if (title !== void 0 && typeof title !== "string") {
      return { ok: false, error: '"title" must be a string' };
    }
    if (parentId !== void 0 && (typeof parentId !== "string" || parentId.trim() === "")) {
      return { ok: false, error: '"parentId" must be a non-empty string' };
    }
    try {
      const { node, created } = ctx.addBookmark(url2?.trim(), title, parentId?.trim());
      return { ok: true, created, node };
    } catch (error) {
      return fail(error);
    }
  },
  "add-folder": (ctx, params) => {
    const { title, parentId } = params ?? {};
    if (typeof title !== "string" || title.trim() === "") {
      return { ok: false, error: 'missing "title"' };
    }
    if (parentId !== void 0 && (typeof parentId !== "string" || parentId.trim() === "")) {
      return { ok: false, error: '"parentId" must be a non-empty string' };
    }
    try {
      const { node } = ctx.addFolder(title.trim(), parentId?.trim());
      return { ok: true, node };
    } catch (error) {
      return fail(error);
    }
  },
  "remove-bookmark": (ctx, params) => {
    const { id } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") {
      return { ok: false, error: 'missing "id"' };
    }
    try {
      const { removed } = ctx.removeBookmark(id.trim());
      return { ok: true, removed, id: id.trim() };
    } catch (error) {
      return fail(error);
    }
  },
  "rename-bookmark": (ctx, params) => {
    const { id, title } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") {
      return { ok: false, error: 'missing "id"' };
    }
    if (typeof title !== "string" || title.trim() === "") {
      return { ok: false, error: 'missing "title"' };
    }
    try {
      const { node } = ctx.renameBookmark(id.trim(), title.trim());
      return { ok: true, node };
    } catch (error) {
      return fail(error);
    }
  },
  "move-bookmark": (ctx, params) => {
    const { id, parentId, index } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") {
      return { ok: false, error: 'missing "id"' };
    }
    if (parentId !== void 0 && parentId !== null && typeof parentId !== "string") {
      return { ok: false, error: '"parentId" must be a string or null' };
    }
    if (index !== void 0 && (typeof index !== "number" || !Number.isInteger(index))) {
      return { ok: false, error: '"index" must be an integer' };
    }
    try {
      const target = parentId === void 0 ? null : parentId;
      const { moved } = ctx.moveBookmark(id.trim(), target, index);
      return { ok: true, moved, id: id.trim() };
    } catch (error) {
      return fail(error);
    }
  },
  "list-bookmarks": (ctx) => {
    const { tree } = ctx.listBookmarks();
    return { ok: true, tree };
  },
  "open-bookmark": (ctx, params) => {
    const { id } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") {
      return { ok: false, error: 'missing "id"' };
    }
    try {
      const { tabId, url: url2 } = ctx.openBookmark(id.trim());
      return { ok: true, tabId, url: url2 };
    } catch (error) {
      return fail(error);
    }
  }
};
const SALT = "saltysalt";
const ITERATIONS = 1003;
const KEY_LENGTH = 16;
const IV = Buffer.alloc(16, 32);
const DOMAIN_HASH_LENGTH = 32;
const CHROME_EPOCH_OFFSET_MICROS = 116444736e8;
function deriveKey(safeStoragePassword) {
  return node_crypto.pbkdf2Sync(safeStoragePassword, SALT, ITERATIONS, KEY_LENGTH, "sha1");
}
function decryptValue(key, encrypted) {
  const prefix = encrypted.subarray(0, 3).toString("latin1");
  if (prefix !== "v10") throw new Error(`unsupported cookie encryption prefix: ${prefix}`);
  const decipher = node_crypto.createDecipheriv("aes-128-cbc", key, IV);
  decipher.setAutoPadding(false);
  const padded = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
  const pad = padded[padded.length - 1];
  const unpadded = pad > 0 && pad <= 16 ? padded.subarray(0, padded.length - pad) : padded;
  return unpadded.subarray(DOMAIN_HASH_LENGTH).toString("utf8");
}
function sameSite(n) {
  switch (n) {
    case 0:
      return "no_restriction";
    case 1:
      return "lax";
    case 2:
      return "strict";
    default:
      return "unspecified";
  }
}
function expiryToUnixSeconds(expiresUtc) {
  if (!expiresUtc || expiresUtc <= 0) return void 0;
  return (expiresUtc - CHROME_EPOCH_OFFSET_MICROS) / 1e6;
}
function cookieUrl(hostKey, isSecure, path2) {
  const host = hostKey.replace(/^\./, "");
  const scheme = isSecure ? "https" : "http";
  const p = path2 && path2.startsWith("/") ? path2 : "/";
  return `${scheme}://${host}${p}`;
}
function rowToSetDetails(row, value) {
  const isSecure = row.is_secure === 1;
  const details = {
    url: cookieUrl(row.host_key, isSecure, row.path),
    name: row.name,
    value,
    path: row.path && row.path.startsWith("/") ? row.path : "/",
    secure: isSecure,
    httpOnly: row.is_httponly === 1,
    sameSite: sameSite(row.samesite)
  };
  if (row.host_key.startsWith(".")) details.domain = row.host_key;
  const exp = expiryToUnixSeconds(row.expires_utc);
  if (exp !== void 0) details.expirationDate = exp;
  return details;
}
function readSafeStorageKey(service = "Chrome Safe Storage") {
  return node_child_process.execFileSync("security", ["find-generic-password", "-w", "-s", service], {
    encoding: "utf8"
  }).trim();
}
const FIELD = "";
const RECORD = "";
function readCookieRows(cookiesDbPath) {
  const tmp = node_path.join(os.tmpdir(), `mira-chrome-cookies-${process.pid}.sqlite`);
  node_fs.copyFileSync(cookiesDbPath, tmp);
  const query = "select host_key, name, path, expires_utc, is_secure, is_httponly, samesite, hex(encrypted_value), coalesce(value,'') from cookies";
  const out = node_child_process.execFileSync("sqlite3", [tmp, "-newline", RECORD, "-separator", FIELD, query], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024
  });
  return out.split(RECORD).map((r) => r.trim()).filter((r) => r.length > 0).map((r) => {
    const f = r.split(FIELD);
    return {
      host_key: f[0],
      name: f[1],
      path: f[2],
      expires_utc: Number(f[3]),
      is_secure: Number(f[4]),
      is_httponly: Number(f[5]),
      samesite: Number(f[6]),
      encrypted_hex: f[7] ?? "",
      value: f[8] ?? ""
    };
  });
}
const DEFAULT_CHROME_DIR = node_path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
const cookieCommands = {
  "import-cookies": async (ctx, params) => {
    const p = params ?? {};
    if (!p.to || !p.profileDir) {
      return { ok: false, error: '"to" (Mira profile id) and "profileDir" are required' };
    }
    try {
      const jar = ctx.cookieJarForProfile(p.to);
      const key = deriveKey(readSafeStorageKey(p.safeStorageService));
      const dbPath = node_path.join(p.userDataDir ?? DEFAULT_CHROME_DIR, p.profileDir, "Cookies");
      const rows = readCookieRows(dbPath);
      let imported = 0;
      let failed = 0;
      const errors = [];
      for (const row of rows) {
        try {
          const value = row.encrypted_hex ? decryptValue(key, Buffer.from(row.encrypted_hex, "hex")) : row.value;
          await jar.set(rowToSetDetails(row, value));
          imported++;
        } catch (error) {
          failed++;
          if (errors.length < 15) {
            const why = error instanceof Error ? error.message : String(error);
            errors.push(`${row.host_key} ${row.name}: ${why}`);
          }
        }
      }
      return { ok: true, imported, failed, total: rows.length, errors };
    } catch (error) {
      return fail(error);
    }
  },
  // Read-only: how many cookies the active tab's site has in its own session.
  // Surfaced in the status bar; also the ground-truth probe for "did the import
  // land in the session this tab actually uses?".
  "count-active-cookies": async (ctx) => {
    try {
      const { url: url2, count } = await ctx.countActiveSiteCookies();
      return { ok: true, url: url2, count };
    } catch (error) {
      return fail(error);
    }
  },
  // Destructive: wipe cookies + cache + storage for a profile (a full sign-out).
  // No `profile` param → the target window's own profile. Open tabs keep their
  // rendered page until reloaded.
  "clear-data": async (ctx, params) => {
    const { profile } = params ?? {};
    try {
      const { id } = await ctx.clearProfileData(profile);
      return { ok: true, profile: id };
    } catch (error) {
      return fail(error);
    }
  },
  // Destructive but scoped: clear one site's data (its cookies + origin storage)
  // in the active tab's session. No `url` → the active tab's site. Reload the tab
  // to see the sign-out take effect.
  "clear-site-data": async (ctx, params) => {
    const { url: url2 } = params ?? {};
    try {
      const result = await ctx.clearSiteData(url2);
      if (!result) return { ok: false, error: "no active site to clear" };
      return { ok: true, ...result };
    } catch (error) {
      return fail(error);
    }
  }
};
const devtoolsCommands = {
  "exec-js": async (ctx, params) => {
    const { code, tabId } = params ?? {};
    if (typeof code !== "string" || code.trim() === "") {
      return { ok: false, error: 'missing "code"' };
    }
    if (tabId !== void 0 && (typeof tabId !== "string" || tabId.trim() === "")) {
      return { ok: false, error: 'invalid "tabId"' };
    }
    try {
      const result = await ctx.execJsInTab(code, tabId);
      return { ok: true, result };
    } catch (error) {
      return fail(error);
    }
  },
  "toggle-devtools": async (ctx) => {
    try {
      const open = ctx.toggleDevToolsInActiveTab();
      return { ok: true, result: { open } };
    } catch (error) {
      return fail(error);
    }
  },
  "inspect-cookies": async (ctx) => {
    try {
      const open = await ctx.inspectCookiesInActiveTab();
      return { ok: true, result: { open } };
    } catch (error) {
      return fail(error);
    }
  }
};
function readDownloadId(params) {
  const { id } = params ?? {};
  return typeof id === "string" && id.trim() !== "" ? id : null;
}
const downloadsCommands = {
  // List every download Mira has tracked this run (newest first) — the data behind
  // the downloads panel, and how a socket/MCP client inspects what's in flight.
  "list-downloads": (ctx) => {
    try {
      const downloads = ctx.listDownloads();
      return { ok: true, downloads, count: downloads.length };
    } catch (error) {
      return fail(error);
    }
  },
  "cancel-download": (ctx, params) => {
    const id = readDownloadId(params);
    if (!id) return { ok: false, error: 'missing "id"' };
    try {
      if (!ctx.cancelDownload(id)) return { ok: false, error: `no active download: ${id}` };
      return { ok: true };
    } catch (error) {
      return fail(error);
    }
  },
  "open-download": async (ctx, params) => {
    const id = readDownloadId(params);
    if (!id) return { ok: false, error: 'missing "id"' };
    try {
      if (!await ctx.openDownload(id)) return { ok: false, error: `cannot open download: ${id}` };
      return { ok: true };
    } catch (error) {
      return fail(error);
    }
  },
  "reveal-download": (ctx, params) => {
    const id = readDownloadId(params);
    if (!id) return { ok: false, error: 'missing "id"' };
    try {
      if (!ctx.revealDownload(id)) return { ok: false, error: `cannot reveal download: ${id}` };
      return { ok: true };
    } catch (error) {
      return fail(error);
    }
  },
  // Drop the finished downloads from the list (the running ones stay).
  "clear-downloads": (ctx) => {
    try {
      return { ok: true, cleared: ctx.clearDownloads() };
    } catch (error) {
      return fail(error);
    }
  },
  // In-flight summary for the status bar (count + earliest start + byte totals).
  "get-download-stats": (ctx) => {
    try {
      return { ok: true, ...ctx.getDownloadStats() };
    } catch (error) {
      return fail(error);
    }
  }
};
const SW_LOG_LEVELS = ["verbose", "info", "warning", "error"];
function serviceWorkerLogLevel(level) {
  return SW_LOG_LEVELS[level] ?? "info";
}
function isServiceWorkerLogLevel(value) {
  return typeof value === "string" && SW_LOG_LEVELS.includes(value);
}
function extensionIdFromUrl(url2) {
  const match = /^chrome-extension:\/\/([a-p]{32})\b/.exec(url2);
  return match ? match[1] : "";
}
function pickServiceWorkerExtensionId(sourceUrl, cachedId, scope) {
  return extensionIdFromUrl(sourceUrl) || cachedId || (scope ? extensionIdFromUrl(scope) : "");
}
function selectServiceWorkerLogs(entries, query = {}) {
  const min = query.minLevel ? SW_LOG_LEVELS.indexOf(query.minLevel) : 0;
  const matched = entries.filter(
    (entry) => (!query.id || entry.extensionId === query.id) && SW_LOG_LEVELS.indexOf(entry.level) >= min
  );
  const limit = query.limit && query.limit > 0 ? Math.floor(query.limit) : matched.length;
  return matched.slice(-limit);
}
function extensionPopoutBounds(details) {
  const bounds = {
    width: Math.max(details.width ?? 380, 160),
    height: Math.max(details.height ?? 630, 160)
  };
  if (typeof details.left === "number") bounds.x = Math.round(details.left);
  if (typeof details.top === "number") bounds.y = Math.round(details.top);
  return bounds;
}
function toExtensionInfo(ext, enabled = true) {
  return { id: ext.id, name: ext.name, version: ext.version, path: ext.path, enabled };
}
const extensionsCommands = {
  "list-extensions": (ctx) => {
    try {
      return { ok: true, extensions: ctx.listExtensions() };
    } catch (error) {
      return fail(error);
    }
  },
  "load-extension": async (ctx, params) => {
    const { path: path2 } = params ?? {};
    if (typeof path2 !== "string" || path2.trim() === "") {
      return { ok: false, error: '"path" must be a non-empty string' };
    }
    try {
      const extension = await ctx.loadExtension(path2);
      return { ok: true, extension };
    } catch (error) {
      return fail(error);
    }
  },
  "install-extension": async (ctx, params) => {
    const { id } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") {
      return { ok: false, error: '"id" must be a non-empty string' };
    }
    try {
      const extension = await ctx.installExtension(id);
      return { ok: true, extension };
    } catch (error) {
      return fail(error);
    }
  },
  "update-extensions": async (ctx) => {
    try {
      await ctx.updateExtensions();
      return { ok: true };
    } catch (error) {
      return fail(error);
    }
  },
  "disable-extension": async (ctx, params) => {
    const { id } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") {
      return { ok: false, error: '"id" must be a non-empty string' };
    }
    try {
      const extension = await ctx.disableExtension(id);
      return { ok: true, extension };
    } catch (error) {
      return fail(error);
    }
  },
  "enable-extension": async (ctx, params) => {
    const { id } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") {
      return { ok: false, error: '"id" must be a non-empty string' };
    }
    try {
      const extension = await ctx.enableExtension(id);
      return { ok: true, extension };
    } catch (error) {
      return fail(error);
    }
  },
  "uninstall-extension": async (ctx, params) => {
    const { id } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") {
      return { ok: false, error: '"id" must be a non-empty string' };
    }
    try {
      return { ok: true, ...await ctx.uninstallExtension(id) };
    } catch (error) {
      return fail(error);
    }
  },
  // Inspect an extension's service-worker (MV3 background) console. Mira can't
  // open devtools on a headless SW, so instead it tails a ring buffer of the
  // worker's console output captured since boot. Diagnoses "the SW threw / never
  // ran" cases (e.g. a Bitwarden passkey popout hitting an unimplemented API)
  // that are otherwise invisible. All params optional: { id, level, limit }.
  "extension-console": (ctx, params) => {
    const p = params ?? {};
    const query = {};
    if (typeof p.id === "string" && p.id.trim() !== "") query.id = p.id;
    if (typeof p.profileId === "string" && p.profileId.trim() !== "") query.profileId = p.profileId;
    if (p.level !== void 0) {
      if (!isServiceWorkerLogLevel(p.level)) {
        return { ok: false, error: `"level" must be one of ${SW_LOG_LEVELS.join(", ")}` };
      }
      query.minLevel = p.level;
    }
    if (p.limit !== void 0) {
      if (typeof p.limit !== "number" || !Number.isFinite(p.limit) || p.limit <= 0) {
        return { ok: false, error: '"limit" must be a positive number' };
      }
      query.limit = p.limit;
    }
    try {
      return { ok: true, messages: ctx.readServiceWorkerConsole(query) };
    } catch (error) {
      return fail(error);
    }
  }
};
const STOP_ACTIONS = [
  "clearSelection",
  "keepSelection",
  "activateSelection"
];
const findCommands = {
  // Show the find bar in the target window (Cmd+F, palette, socket). The search
  // itself starts when the chrome sends find-in-page with the typed text.
  "find-open": (ctx) => {
    try {
      ctx.openFindBar();
      return { ok: true };
    } catch (error) {
      return fail(error);
    }
  },
  "find-in-page": (ctx, params) => {
    const { text, forward, findNext } = params ?? {};
    if (typeof text !== "string" || text === "") {
      return { ok: false, error: 'missing "text"' };
    }
    if (forward !== void 0 && typeof forward !== "boolean") {
      return { ok: false, error: '"forward" must be a boolean' };
    }
    if (findNext !== void 0 && typeof findNext !== "boolean") {
      return { ok: false, error: '"findNext" must be a boolean' };
    }
    try {
      ctx.findInPage(text, forward ?? true, !(findNext ?? false));
      return { ok: true };
    } catch (error) {
      return fail(error);
    }
  },
  // Step the current search (Cmd+G / Cmd+Shift+G, Enter in the find bar).
  // `found:false` when there is no active search — not an error, the
  // accelerators can fire at any time.
  "find-next": (ctx) => {
    try {
      return { ok: true, found: ctx.findStep(true) };
    } catch (error) {
      return fail(error);
    }
  },
  "find-previous": (ctx) => {
    try {
      return { ok: true, found: ctx.findStep(false) };
    } catch (error) {
      return fail(error);
    }
  },
  "find-stop": (ctx, params) => {
    const { action } = params ?? {};
    if (action !== void 0 && !STOP_ACTIONS.includes(action)) {
      return { ok: false, error: `"action" must be one of ${STOP_ACTIONS.join(", ")}` };
    }
    try {
      ctx.stopFindInPage(action ?? "clearSelection");
      return { ok: true };
    } catch (error) {
      return fail(error);
    }
  }
};
const folderMenuCommands = {
  // The sidebar's right-click on a folder header: pop the native folder menu for
  // `folderId`. The native popup appears at the cursor and composites above the
  // WebContentsView.
  "show-folder-menu": (ctx, params) => {
    const { folderId } = params ?? {};
    if (typeof folderId !== "string" || folderId.trim() === "") {
      return { ok: false, error: 'missing "folderId"' };
    }
    try {
      ctx.showFolderMenu(folderId.trim());
      return { ok: true };
    } catch (error) {
      return fail(error);
    }
  }
};
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1e3;
function clampLimit(limit) {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(limit), 0), MAX_LIMIT);
}
const historyCommands = {
  "list-history": (ctx, params) => {
    const { limit } = params ?? {};
    try {
      const entries = ctx.listHistory(clampLimit(limit));
      return { ok: true, entries };
    } catch (error) {
      return fail(error);
    }
  },
  "search-history": (ctx, params) => {
    const { query, limit } = params ?? {};
    if (typeof query !== "string") {
      return { ok: false, error: 'missing "query"' };
    }
    try {
      const entries = ctx.searchHistory(query, clampLimit(limit));
      return { ok: true, entries };
    } catch (error) {
      return fail(error);
    }
  },
  "clear-history": (ctx) => {
    try {
      const { cleared } = ctx.clearHistory();
      return { ok: true, cleared };
    } catch (error) {
      return fail(error);
    }
  }
};
const VALID_MODIFIERS = /* @__PURE__ */ new Set(["alt", "ctrl", "meta", "shift"]);
const inputCommands = {
  "press-key": async (ctx, params) => {
    const { key, tabId, modifiers } = params ?? {};
    if (typeof key !== "string" || key.length === 0) {
      return { ok: false, error: 'missing "key"' };
    }
    if (tabId !== void 0 && (typeof tabId !== "string" || tabId.trim() === "")) {
      return { ok: false, error: 'invalid "tabId"' };
    }
    if (modifiers !== void 0) {
      if (!Array.isArray(modifiers) || modifiers.some((m) => !VALID_MODIFIERS.has(m))) {
        return { ok: false, error: 'invalid "modifiers" (alt|ctrl|meta|shift)' };
      }
    }
    try {
      await ctx.pressKeyInTab(key, tabId, modifiers);
      return { ok: true, result: { key } };
    } catch (error) {
      return fail(error);
    }
  }
};
const NO_MAGNIFIER = { scale: 1, originX: 0, originY: 0 };
const MAG_MIN_SCALE = 1;
const MAG_WHEEL_K = 2e-3;
const MAG_SNAP_OUT = 1.05;
const ZOOM_EPSILON = 1e-3;
const clamp$2 = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clampScale = (s) => Math.max(MAG_MIN_SCALE, s);
function isMagnified(state) {
  return state.scale > MAG_MIN_SCALE + ZOOM_EPSILON;
}
function clampOrigin(state, width, height) {
  const maxX = Math.max(0, (state.scale - 1) * width);
  const maxY = Math.max(0, (state.scale - 1) * height);
  return {
    scale: state.scale,
    originX: clamp$2(state.originX, 0, maxX),
    originY: clamp$2(state.originY, 0, maxY)
  };
}
function pageAt(state, surfaceX, surfaceY) {
  return {
    x: (surfaceX + state.originX) / state.scale,
    y: (surfaceY + state.originY) / state.scale
  };
}
function zoomAt(state, cursorX, cursorY, deltaY, width, height) {
  let nextScale = clampScale(state.scale * Math.exp(-deltaY * MAG_WHEEL_K));
  if (deltaY > 0 && nextScale < MAG_SNAP_OUT) nextScale = MAG_MIN_SCALE;
  const anchor = pageAt(state, cursorX, cursorY);
  const next = {
    scale: nextScale,
    originX: anchor.x * nextScale - cursorX,
    originY: anchor.y * nextScale - cursorY
  };
  return clampOrigin(next, width, height);
}
function panBy(state, deltaX, deltaY, width, height) {
  return clampOrigin(
    { scale: state.scale, originX: state.originX + deltaX, originY: state.originY + deltaY },
    width,
    height
  );
}
function applyMagnifierJs(state) {
  const { scale, originX, originY } = state;
  return `(() => { const e = document.documentElement; if (e.__miraMagPrev === undefined) { e.__miraMagPrev = e.style.transform || ''; e.__miraMagPrevOrigin = e.style.transformOrigin || ''; e.__miraMagPrevOverflow = e.style.overflow || ''; } const k = ${scale}, sx = window.scrollX || 0, sy = window.scrollY || 0; const tx = ${-originX} - sx * (k - 1), ty = ${-originY} - sy * (k - 1); e.style.transformOrigin = '0 0'; e.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(' + k + ')'; e.style.overflow = 'hidden'; })();`;
}
const CLEAR_MAGNIFIER_JS = `(() => { const e = document.documentElement; if (e.__miraMagPrev !== undefined) { e.style.transform = e.__miraMagPrev; e.style.transformOrigin = e.__miraMagPrevOrigin; e.style.overflow = e.__miraMagPrevOverflow; delete e.__miraMagPrev; delete e.__miraMagPrevOrigin; delete e.__miraMagPrevOverflow; } })();`;
const MAG_BINDING = "__miraMagnifier";
const MAGNIFIER_SHIM = `(() => {
  if (window.__miraMag) return;
  const state = { captureWheel: false, swallowClicks: false };
  window.__miraMag = state;
  const send = (o) => { try { window.${MAG_BINDING}(JSON.stringify(o)); } catch (e) {} };
  const frozen = [];
  let idleTimer = 0;
  const unfreeze = () => {
    for (const f of frozen) {
      f.el.style.overflowX = f.ox; f.el.style.overflowY = f.oy;
      f.el.scrollLeft = f.x; f.el.scrollTop = f.y;
    }
    frozen.length = 0;
  };
  const scrolls = (ov, extra) => (ov === 'auto' || ov === 'scroll') && extra > 0;
  const freeze = (start) => {
    if (!frozen.length) {
      // Walk up from the wheel target (escaping shadow roots via the host),
      // stopping at the root/body: those belong to the magnifier's own freeze.
      for (let el = start; el && el !== document.documentElement && el !== document.body;
           el = el.parentElement || el.getRootNode()?.host) {
        if (!(el instanceof Element)) break;
        const s = getComputedStyle(el);
        if (scrolls(s.overflowY, el.scrollHeight - el.clientHeight) ||
            scrolls(s.overflowX, el.scrollWidth - el.clientWidth)) {
          frozen.push({ el, ox: el.style.overflowX, oy: el.style.overflowY,
            x: el.scrollLeft, y: el.scrollTop });
          el.style.overflow = 'hidden';
        }
      }
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(unfreeze, 250);
  };
  window.addEventListener('wheel', (e) => {
    if (!state.captureWheel && !e.metaKey) return;
    e.preventDefault();
    freeze(e.target);
    send({ t: 'wheel', dy: e.deltaY, dx: e.deltaX, meta: e.metaKey, x: e.clientX, y: e.clientY });
  }, { capture: true, passive: false });
  window.addEventListener('click', (e) => {
    if (!state.swallowClicks) return;
    e.preventDefault(); e.stopImmediatePropagation();
  }, { capture: true });
})();`;
function setShimFlags(captureWheel, swallowClicks) {
  return `window.__miraMag && (window.__miraMag.captureWheel = ${captureWheel ? "true" : "false"}, window.__miraMag.swallowClicks = ${swallowClicks ? "true" : "false"});`;
}
function magnifierFrameJs(on) {
  const id = "__miraMagFrame";
  if (!on) {
    return `(() => { const el = document.getElementById('${id}'); if (el) { try { el.hidePopover(); } catch (e) {} el.remove(); } })();`;
  }
  return `(() => { let el = document.getElementById('${id}'); if (!el) { el = document.createElement('div'); el.id = '${id}'; el.setAttribute('popover', 'manual'); el.style.cssText = 'margin:0;padding:0;inset:0;width:auto;height:auto;' + 'background:transparent;border:3px solid rgba(255,60,60,0.9);box-sizing:border-box;' + 'pointer-events:none;'; document.documentElement.appendChild(el); } if (!el.matches(':popover-open')) { try { el.showPopover(); } catch (e) {} } })();`;
}
const MAGNIFIER_FLASH = `(() => {
  const id = '__miraMagFlash';
  document.getElementById(id)?.remove();
  const el = document.createElement('div');
  el.id = id;
  el.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;' +
    'border:4px solid rgba(90,160,255,0.9);box-sizing:border-box;' +
    'animation:__miraMagFlash 320ms ease-out forwards';
  const style = document.createElement('style');
  style.textContent = '@keyframes __miraMagFlash{from{opacity:1}to{opacity:0}}';
  el.appendChild(style);
  document.documentElement.appendChild(el);
  setTimeout(() => el.remove(), 360);
})();`;
const num = (v) => typeof v === "number" && Number.isFinite(v);
const magnifierCommands = {
  // Cmd+scroll: zoom the active tab, anchored on the cursor. cursorX/cursorY are
  // surface CSS px (== the shim's clientX/clientY, since input isn't remapped).
  "magnifier-zoom": (ctx, params) => {
    const { deltaY, cursorX, cursorY } = params ?? {};
    if (!num(deltaY) || !num(cursorX) || !num(cursorY)) {
      return { ok: false, error: '"deltaY", "cursorX", "cursorY" must be numbers' };
    }
    const target = ctx.magnifierTarget();
    if (!target) return { ok: false, error: "no magnifiable view" };
    try {
      const prev = ctx.getMagnifierState(target.id);
      const next = zoomAt(prev, cursorX, cursorY, deltaY, target.width, target.height);
      ctx.setMagnifierState(target.id, next);
      ctx.applyMagnifierClip(target.id, next);
      if (isMagnified(prev) && !isMagnified(next)) ctx.magnifierFlash(target.id);
      return { ok: true, scale: next.scale, magnified: isMagnified(next) };
    } catch (error) {
      return fail(error);
    }
  },
  // Plain scroll while magnified: pan the loupe. A no-op (no clip change) when
  // not magnified — the shim only forwards scroll in that case anyway.
  "magnifier-pan": (ctx, params) => {
    const { deltaX, deltaY } = params ?? {};
    if (!num(deltaX) || !num(deltaY)) {
      return { ok: false, error: '"deltaX", "deltaY" must be numbers' };
    }
    const target = ctx.magnifierTarget();
    if (!target) return { ok: false, error: "no magnifiable view" };
    try {
      const prev = ctx.getMagnifierState(target.id);
      const next = panBy(prev, deltaX, deltaY, target.width, target.height);
      ctx.setMagnifierState(target.id, next);
      ctx.applyMagnifierClip(target.id, next);
      return { ok: true, magnified: isMagnified(next) };
    } catch (error) {
      return fail(error);
    }
  },
  // Snap back to 100% (e.g. from a menu or the socket). Flashes if it was zoomed.
  "magnifier-reset": (ctx) => {
    const target = ctx.magnifierTarget();
    if (!target) return { ok: false, error: "no magnifiable view" };
    try {
      const was = isMagnified(ctx.getMagnifierState(target.id));
      const next = { scale: 1, originX: 0, originY: 0 };
      ctx.setMagnifierState(target.id, next);
      ctx.applyMagnifierClip(target.id, next);
      if (was) ctx.magnifierFlash(target.id);
      return { ok: true, scale: 1, magnified: false };
    } catch (error) {
      return fail(error);
    }
  },
  "magnifier-state": (ctx) => {
    const target = ctx.magnifierTarget();
    if (!target) return { ok: false, error: "no magnifiable view" };
    const state = ctx.getMagnifierState(target.id);
    return { ok: true, ...state, magnified: isMagnified(state) };
  }
};
function extOf(url2) {
  const path2 = url2.split(/[?#]/)[0];
  const dot = path2.lastIndexOf(".");
  const slash = path2.lastIndexOf("/");
  if (dot <= slash) return "";
  return path2.slice(dot + 1).toLowerCase();
}
const EXT_KIND = {
  svg: "svg",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  bmp: "image",
  ico: "image",
  mp4: "video",
  webm: "video",
  mov: "video",
  m4v: "video",
  ogv: "video",
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  m4a: "audio",
  aac: "audio",
  flac: "audio",
  woff: "font",
  woff2: "font",
  ttf: "font",
  otf: "font",
  eot: "font"
};
function classifyMedia(input) {
  const m = (input.mime ?? "").toLowerCase();
  if (m.startsWith("image/svg")) return "svg";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("font/") || m.includes("font/")) return "font";
  const rt = (input.resourceType ?? "").toLowerCase();
  if (rt === "image") return "image";
  if (rt === "font") return "font";
  const byExt = EXT_KIND[extOf(input.url ?? "")];
  if (byExt) return byExt;
  if (rt === "media") return "video";
  return "other";
}
function estimateEntryBytes(item) {
  const strChars = (item.url?.length ?? 0) + (item.mime?.length ?? 0) + (item.alt?.length ?? 0);
  return strChars * 2 + 96;
}
function estimateBufferBytes(items) {
  let total = 0;
  for (const it of items) total += estimateEntryBytes(it);
  return total;
}
function formatCaptureMemory(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}
function mergeMedia(items) {
  const byUrl = /* @__PURE__ */ new Map();
  const out = [];
  for (const it of items) {
    if (!it.url) {
      out.push({ ...it, sources: [...it.sources] });
      continue;
    }
    const existing = byUrl.get(it.url);
    if (!existing) {
      const copy = { ...it, sources: [...it.sources] };
      byUrl.set(it.url, copy);
      out.push(copy);
      continue;
    }
    for (const s of it.sources) if (!existing.sources.includes(s)) existing.sources.push(s);
    existing.width ??= it.width;
    existing.height ??= it.height;
    existing.mime ??= it.mime;
    existing.alt ??= it.alt;
    existing.bytes ??= it.bytes;
    existing.poster ??= it.poster;
    existing.pageUrl ??= it.pageUrl;
    if (it.tainted) existing.tainted = true;
  }
  return out;
}
class MediaBuffer {
  constructor(cap = 800) {
    this.cap = cap;
  }
  cap;
  items = /* @__PURE__ */ new Map();
  /** Record a media response. New url → appended (evicting the oldest if the cap
   * is reached); known url → fields filled in, order kept. Ignores urls that are
   * empty or data: (those come from the DOM pass, not the wire). */
  add(input) {
    const { url: url2 } = input;
    if (!url2 || url2.startsWith("data:")) return;
    const existing = this.items.get(url2);
    if (existing) {
      existing.mime ??= input.mime;
      existing.bytes ??= input.bytes;
      return;
    }
    if (this.items.size >= this.cap) {
      const oldest = this.items.keys().next().value;
      if (oldest !== void 0) this.items.delete(oldest);
    }
    this.items.set(url2, {
      url: url2,
      kind: classifyMedia(input),
      mime: input.mime,
      bytes: input.bytes,
      sources: ["network"]
    });
  }
  /** Every buffered item, oldest first, as fresh copies (callers merge/mutate). */
  list() {
    return [...this.items.values()].map((it) => ({ ...it, sources: [...it.sources] }));
  }
  /** How many entries the buffer holds. */
  count() {
    return this.items.size;
  }
  /** The buffer's estimated RAM footprint (metadata only). */
  bytes() {
    return estimateBufferBytes([...this.items.values()]);
  }
  /** Drop everything (e.g. the tab navigated away — optional caller policy). */
  clear() {
    this.items.clear();
  }
}
const MIME_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/ogg": "ogv",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "font/woff": "woff",
  "font/woff2": "woff2",
  "font/ttf": "ttf",
  "font/otf": "otf"
};
function mimeToExt(mime) {
  return MIME_EXT[(mime ?? "").toLowerCase()] ?? "";
}
function fileNameFor(url2, mime) {
  if (url2.startsWith("data:")) return `download.${mimeToExt(mime) || "bin"}`;
  let path2 = url2;
  try {
    path2 = new URL(url2).pathname;
  } catch {
  }
  let base = path2.split(/[?#]/)[0].split("/").pop() ?? "";
  try {
    base = decodeURIComponent(base);
  } catch {
  }
  if (!base) base = "download";
  if (!extOf(base)) {
    const ext = mimeToExt(mime);
    if (ext) base = `${base}.${ext}`;
  }
  return base;
}
function captureStats(buffers) {
  let count = 0;
  let bytes = 0;
  for (const b of buffers) {
    count += b.count();
    bytes += b.bytes();
  }
  return { count, bytes };
}
function readUrls(params) {
  const p = params ?? {};
  const raw = Array.isArray(p.urls) ? p.urls : p.url !== void 0 ? [p.url] : [];
  return raw.filter((u) => typeof u === "string" && u.trim() !== "");
}
const mediaCommands = {
  "collect-media": async (ctx, params) => {
    const { tabId } = params ?? {};
    if (tabId !== void 0 && (typeof tabId !== "string" || tabId.trim() === "")) {
      return { ok: false, error: 'invalid "tabId"' };
    }
    try {
      const media = await ctx.collectMedia(tabId);
      return { ok: true, media, count: media.length };
    } catch (error) {
      return fail(error);
    }
  },
  "download-media": async (ctx, params) => {
    const urls = readUrls(params);
    if (urls.length === 0) return { ok: false, error: 'missing "url" or "urls"' };
    const { tabId } = params ?? {};
    if (tabId !== void 0 && (typeof tabId !== "string" || tabId.trim() === "")) {
      return { ok: false, error: 'invalid "tabId"' };
    }
    try {
      const { saved, failed } = await ctx.downloadMedia(urls, tabId);
      return { ok: true, saved, failed };
    } catch (error) {
      return fail(error);
    }
  },
  // Download a streamed video (MSE/HLS/blob with no file URL) via yt-dlp. `url` is
  // the precise per-video permalink. Runs in the background — a true file download.
  "download-video-url": async (ctx, params) => {
    const { url: url2 } = params ?? {};
    if (typeof url2 !== "string" || url2.trim() === "") {
      return { ok: false, error: 'missing "url"' };
    }
    try {
      const res = await ctx.downloadVideoUrl(url2);
      if (!res.saved) return { ok: false, error: res.error ?? "download failed" };
      return { ok: true, file: res.file };
    } catch (error) {
      return fail(error);
    }
  },
  "get-media-stats": (ctx) => {
    try {
      const { count, bytes, downloads } = ctx.getMediaStats();
      const active = downloads ?? [];
      const since = active.length ? Math.min(...active.map((d) => d.startedAt)) : null;
      return {
        ok: true,
        count,
        bytes,
        text: formatCaptureMemory(bytes),
        downloads: active.length,
        downloadingSince: since
      };
    } catch (error) {
      return fail(error);
    }
  },
  // Open / close / toggle the gallery. `open` omitted → toggle; a boolean forces
  // it. The global shortcut and the socket both reach this.
  "toggle-media-gallery": (ctx, params) => {
    const { open } = params ?? {};
    if (open !== void 0 && typeof open !== "boolean") {
      return { ok: false, error: '"open" must be a boolean' };
    }
    try {
      const result = ctx.setMediaGalleryOpen(open);
      return { ok: true, open: result.open };
    } catch (error) {
      return fail(error);
    }
  },
  "open-media-gallery": (ctx) => {
    try {
      return { ok: true, open: ctx.setMediaGalleryOpen(true).open };
    } catch (error) {
      return fail(error);
    }
  },
  "close-media-gallery": (ctx) => {
    try {
      return { ok: true, open: ctx.setMediaGalleryOpen(false).open };
    } catch (error) {
      return fail(error);
    }
  }
};
const SEARCH_URL = "https://www.google.com/search?q=";
function localFileUrl(input) {
  let path2;
  if (input === "~" || input.startsWith("~/")) {
    path2 = os.homedir() + input.slice(1);
  } else if (input.startsWith("/")) {
    path2 = input;
  } else {
    return null;
  }
  return node_url.pathToFileURL(path2).href;
}
function normalizeInput(raw) {
  const input = raw.trim();
  if (input === "") return "";
  if (/^(https?|file|chrome-extension):\/\//i.test(input) || /^about:/i.test(input)) {
    return input;
  }
  const fileUrl = localFileUrl(input);
  if (fileUrl !== null) return fileUrl;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(input)) {
    return `http://${input}`;
  }
  if (!/\s/.test(input) && /^[^\s]+\.[^\s]+$/.test(input)) {
    return `https://${input}`;
  }
  return `${SEARCH_URL}${encodeURIComponent(input)}`;
}
function settingsSectionFor(raw) {
  const input = raw.trim().toLowerCase().replace(/\/+$/, "");
  const match = /^(?:chrome|mira):\/\/([^/]+)(?:\/([^/]+))?$/.exec(input);
  if (!match) return null;
  const [, host, sub] = match;
  if (host === "extensions") return "extensions";
  if (host === "settings") return sub ?? "general";
  return null;
}
function sameUrl(a, b) {
  if (a === b) return true;
  try {
    const norm = (raw) => {
      const u = new URL(raw);
      return u.origin + u.pathname.replace(/\/$/, "") + u.search + u.hash;
    };
    return norm(a) === norm(b);
  } catch {
    return false;
  }
}
const ZOOM_STEP = 0.5;
const ZOOM_MIN = -3;
const ZOOM_MAX = 5;
function nextZoomLevel(current, steps) {
  const level = current + steps * ZOOM_STEP;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
}
const navigationCommands = {
  navigate: (ctx, params) => {
    const { url: url2, newTab } = params ?? {};
    if (newTab !== void 0 && typeof newTab !== "boolean") {
      return { ok: false, error: '"newTab" must be a boolean' };
    }
    const section = settingsSectionFor(url2 ?? "");
    if (section !== null) {
      try {
        ctx.openSettings(section);
        return { ok: true, settings: section };
      } catch (error) {
        return fail(error);
      }
    }
    const normalized = normalizeInput(url2 ?? "");
    if (normalized === "") return { ok: false, error: "empty input" };
    const { tabs, activeId } = ctx.listTabs();
    const active = tabs.find((t) => t.id === activeId);
    const existing = tabs.find(
      (t) => t.kind === "web" && sameUrl(t.url, normalized) && (newTab === true || t.id !== activeId)
    );
    if (existing) {
      try {
        ctx.selectTab(existing.id);
        return { ok: true, url: normalized, id: existing.id, focused: true };
      } catch (error) {
        return fail(error);
      }
    }
    if (newTab === true || activeId === null || active?.kind === "settings") {
      try {
        const tab = ctx.newTab(normalized);
        return { ok: true, url: normalized, id: tab.id };
      } catch (error) {
        return fail(error);
      }
    }
    ctx.getTargetWebContents().loadURL(normalized);
    return { ok: true, url: normalized };
  },
  back: (ctx) => {
    ctx.getTargetWebContents().goBack();
    return { ok: true };
  },
  forward: (ctx) => {
    ctx.getTargetWebContents().goForward();
    return { ok: true };
  },
  reload: (ctx) => {
    ctx.getTargetWebContents().reload();
    return { ok: true };
  },
  // Hard reload: re-fetch the page bypassing the HTTP cache (Cmd+Shift+R),
  // for when a plain reload serves a stale cached response.
  "hard-reload": (ctx) => {
    ctx.getTargetWebContents().reloadIgnoringCache();
    return { ok: true };
  },
  // Zoom the active tab's page. Chrome's zoom is per-webContents and log-scaled
  // (factor = 1.2^level); we step the level and clamp it (see nextZoomLevel).
  "zoom-in": (ctx) => {
    const wc = ctx.getTargetWebContents();
    const level = nextZoomLevel(wc.getZoomLevel(), 1);
    wc.setZoomLevel(level);
    return { ok: true, level };
  },
  "zoom-out": (ctx) => {
    const wc = ctx.getTargetWebContents();
    const level = nextZoomLevel(wc.getZoomLevel(), -1);
    wc.setZoomLevel(level);
    return { ok: true, level };
  },
  "zoom-reset": (ctx) => {
    const wc = ctx.getTargetWebContents();
    wc.setZoomLevel(0);
    return { ok: true, level: 0 };
  }
};
function fileUrlFor(path2) {
  return node_url.pathToFileURL(path2).href;
}
function readProfileId(params) {
  const raw = params ?? {};
  if (!("profileId" in raw) || raw.profileId === void 0) return void 0;
  if (typeof raw.profileId !== "string" || raw.profileId.trim() === "") {
    throw new Error('invalid "profileId"');
  }
  return raw.profileId;
}
const openCommands = {
  // A clicked link handed to Mira as the default browser (mirrors the macOS
  // 'open-url' event), or an explicit socket/MCP request to open a page. Without
  // `profileId` it lands in the last-focused profile; with it, in that profile.
  "open-url": (ctx, params) => {
    const { url: url2 } = params ?? {};
    if (typeof url2 !== "string" || url2.trim() === "") {
      return { ok: false, error: 'missing "url"' };
    }
    try {
      const profileId = readProfileId(params);
      ctx.openExternalUrl(url2, profileId);
      return profileId ? { ok: true, url: url2, profileId } : { ok: true, url: url2 };
    } catch (error) {
      return fail(error);
    }
  },
  // A local file opened via `open foo.html` / double-click (mirrors the macOS
  // 'open-file' event). The path is turned into a file:// URL and opened in the
  // last-focused profile, or in `profileId` when given.
  "open-file": (ctx, params) => {
    const { path: path2 } = params ?? {};
    if (typeof path2 !== "string" || path2.trim() === "") {
      return { ok: false, error: 'missing "path"' };
    }
    const url2 = fileUrlFor(path2);
    try {
      const profileId = readProfileId(params);
      ctx.openExternalUrl(url2, profileId);
      return profileId ? { ok: true, url: url2, profileId } : { ok: true, url: url2 };
    } catch (error) {
      return fail(error);
    }
  }
};
const STATIC_COMMANDS = [
  {
    id: "cmd:new-tab",
    title: "New Tab",
    command: "new-tab",
    keywords: "open create",
    shortcut: "⌘T"
  },
  {
    id: "cmd:close-tab",
    title: "Close Tab",
    command: "close-active-tab",
    keywords: "quit",
    shortcut: "⌘W"
  },
  {
    id: "cmd:reload",
    title: "Reload Page",
    command: "reload",
    keywords: "refresh",
    shortcut: "⌘R"
  },
  {
    id: "cmd:hard-reload",
    title: "Hard Reload Page",
    command: "hard-reload",
    keywords: "refresh cache bypass stale force",
    shortcut: "⇧⌘R"
  },
  {
    id: "cmd:find",
    title: "Find in Page",
    command: "find-open",
    keywords: "search text match locate",
    shortcut: "⌘F"
  },
  { id: "cmd:back", title: "Back", command: "back", keywords: "history previous", shortcut: "⌘←" },
  {
    id: "cmd:forward",
    title: "Forward",
    command: "forward",
    keywords: "history next",
    shortcut: "⌘→"
  },
  {
    id: "cmd:discard-tab",
    title: "Discard Tab",
    command: "discard-active-tab",
    keywords: "sleep unload memory ram",
    shortcut: "⌘S"
  },
  {
    id: "cmd:toggle-panel",
    title: "Toggle Tab Panel",
    command: "toggle-tabs-panel",
    keywords: "sidebar hide show",
    shortcut: "⌘B"
  },
  {
    id: "cmd:add-bookmark",
    title: "Add to Favorites",
    command: "add-bookmark",
    keywords: "bookmark star favorite",
    shortcut: "⌘D"
  },
  {
    id: "cmd:settings",
    title: "Open Settings",
    command: "open-settings",
    keywords: "preferences config options",
    shortcut: "⌘,"
  },
  { id: "cmd:new-profile", title: "New Profile", command: "create-profile", keywords: "account" },
  {
    id: "cmd:clear-site-data",
    title: "Clear Data for This Site",
    command: "clear-site-data",
    keywords: "cookies storage logout sign out forget site current page"
  },
  {
    id: "cmd:clear-data",
    title: "Clear Browsing Data",
    command: "clear-data",
    keywords: "cookies cache storage logout sign out wipe reset all profile"
  }
];
function bookmarkEntries(nodes) {
  const out = [];
  for (const node of nodes) {
    if (node.kind === "url" && node.url) {
      out.push({
        id: `bookmark:${node.id}`,
        title: node.title?.trim() || node.url,
        subtitle: node.url,
        group: "Bookmarks",
        command: "open-bookmark",
        params: { id: node.id },
        // Navigable: the chrome opens it in the current tab or a new one per the
        // palette mode. `command` stays open-bookmark as the plain fallback.
        url: node.url
      });
    } else if (node.kind === "folder" && node.children) {
      out.push(...bookmarkEntries(node.children));
    }
  }
  return out;
}
function buildPaletteEntries(state) {
  const skills = state.skills.map((s) => ({
    id: `skill:${s.id}`,
    title: s.name,
    group: "Skills",
    command: "run-skill",
    params: { id: s.id },
    keywords: "skill ai summarize this page"
  }));
  const commands = STATIC_COMMANDS.map((c) => ({ ...c, group: "Commands" }));
  const tabs = state.tabs.filter((t) => t.id !== state.activeId).map((t) => ({
    id: `tab:${t.id}`,
    title: t.title?.trim() || t.url || "New Tab",
    subtitle: t.kind === "settings" ? "Settings" : t.url || void 0,
    group: "Tabs",
    command: "select-tab",
    params: { id: t.id },
    keywords: "switch tab"
  }));
  const bookmarks = bookmarkEntries(state.bookmarks);
  const bookmarkedUrls = new Set(bookmarks.map((b) => b.url));
  const history = state.history.filter((h) => !bookmarkedUrls.has(h.url)).map((h) => ({
    id: `history:${h.url}`,
    title: h.title?.trim() || h.url,
    subtitle: h.url,
    group: "History",
    command: "navigate",
    params: { url: h.url },
    url: h.url
  }));
  const profiles = state.profiles.filter((p) => p.id !== state.focusedProfile).map((p) => ({
    id: `profile:${p.id}`,
    title: `Switch to ${p.label}`,
    subtitle: p.open ? "open" : "closed",
    group: "Profiles",
    command: "open-profile",
    params: { id: p.id },
    keywords: "profile account"
  }));
  return [...skills, ...commands, ...tabs, ...bookmarks, ...history, ...profiles];
}
const BUILTIN_SKILLS = [
  {
    id: "summarize-page",
    name: "Summarize this page",
    match: {},
    prompt: "Summarize the following page content in a few clear, concise bullet points. Keep only what matters; drop navigation and boilerplate.",
    source: { kind: "readability" },
    sink: { kind: "pane" }
  }
];
function hostOf(url2) {
  try {
    const u = new URL(url2);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname;
  } catch {
    return null;
  }
}
function matchesHost(match, host) {
  if (!match.host) return true;
  return host === match.host || host.endsWith("." + match.host);
}
function resolveSkills(url2, skills = BUILTIN_SKILLS) {
  const host = hostOf(url2);
  if (host === null) return [];
  return skills.filter((s) => matchesHost(s.match, host));
}
function extractionScript(source) {
  if (source.kind === "selector") {
    const sel = JSON.stringify(source.selector);
    return `(() => { const el = document.querySelector(${sel}); return el ? (el.innerText || el.textContent || '') : ''; })()`;
  }
  if (source.kind === "readability") {
    return `(() => { const el = document.querySelector('article, main, [role="main"]') || document.body; return el ? (el.innerText || '') : ''; })()`;
  }
  return `(() => document.body ? document.body.innerText : '')()`;
}
function extractiveSummary(text, maxChars = 600) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  const sentences = clean.match(/[^.!?]+[.!?]+/g);
  if (!sentences) return clean.slice(0, maxChars).trim();
  let out = "";
  for (const s of sentences) {
    if (out && (out + s).length > maxChars) break;
    out += s;
  }
  return (out.trim() || clean.slice(0, maxChars)).trim();
}
const PALETTE_HISTORY_LIMIT = 200;
const paletteCommands = {
  "list-palette": (ctx) => {
    const { tabs, activeId } = ctx.listTabs();
    const { tree } = ctx.listBookmarks();
    const { profiles, focused } = ctx.listProfiles();
    const history = ctx.listHistory(PALETTE_HISTORY_LIMIT);
    const skills = resolveSkills(ctx.activeUrl() ?? "").map((s) => ({ id: s.id, name: s.name }));
    const entries = buildPaletteEntries({
      tabs: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, kind: t.kind })),
      activeId,
      bookmarks: tree,
      history: history.map((h) => ({ url: h.url, title: h.title })),
      profiles,
      focusedProfile: focused,
      skills
    });
    return { ok: true, entries };
  },
  // Cmd+K toggles (no arg); the chrome passes an explicit `open` to close after a
  // pick / Esc so the two stay in sync regardless of who initiated the change.
  "toggle-palette": (ctx, params) => {
    const { open, mode, query } = params ?? {};
    if (open !== void 0 && typeof open !== "boolean") {
      return { ok: false, error: '"open" must be a boolean' };
    }
    if (mode !== void 0 && mode !== "launcher" && mode !== "address") {
      return { ok: false, error: '"mode" must be "launcher" or "address"' };
    }
    if (query !== void 0 && typeof query !== "string") {
      return { ok: false, error: '"query" must be a string' };
    }
    try {
      const result = ctx.setPaletteOpen(open, mode, query);
      return { ok: true, open: result.open };
    } catch (error) {
      return fail(error);
    }
  }
};
function closedSkillPane() {
  return { open: false, title: "", status: "idle", messages: [] };
}
function lastAnswer(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return messages[i].text;
  }
  return void 0;
}
const paneCommands = {
  "get-skill-pane": (ctx) => {
    try {
      return { ok: true, pane: ctx.getSkillPane() };
    } catch (error) {
      return fail(error);
    }
  },
  "close-skill-pane": (ctx) => {
    try {
      ctx.closeSkillPane();
      return { ok: true, open: false };
    } catch (error) {
      return fail(error);
    }
  },
  // Open / close / toggle the pane, keeping its content. The toolbar button uses
  // this to open the pane ANYTIME (even with no prior result — then it shows just
  // the prompt box). `open` omitted → toggle; a boolean forces that state.
  "toggle-skill-pane": (ctx, params) => {
    const { open } = params ?? {};
    if (open !== void 0 && typeof open !== "boolean") {
      return { ok: false, error: '"open" must be a boolean' };
    }
    try {
      const pane = ctx.getSkillPane();
      const next = open ?? !pane.open;
      ctx.showSkillPane({ ...pane, open: next });
      return { ok: true, open: next };
    } catch (error) {
      return fail(error);
    }
  },
  // Empty the conversation, keeping the pane open. The "Clear chat" button uses
  // this to start a fresh thread; the retained turns and any error are dropped.
  "clear-chat": (ctx) => {
    try {
      const pane = ctx.getSkillPane();
      ctx.showSkillPane({ ...pane, messages: [], status: "idle", error: void 0 });
      return { ok: true, cleared: true };
    } catch (error) {
      return fail(error);
    }
  },
  // Copy the latest assistant answer to the OS clipboard (the "Copy" button).
  // Pilotable too: an agent can pull the last answer out of Mira via the socket.
  "copy-chat": (ctx) => {
    try {
      const answer = lastAnswer(ctx.getSkillPane().messages);
      if (answer === void 0 || answer.trim() === "") {
        return { ok: false, error: "nothing to copy" };
      }
      ctx.writeClipboard(answer);
      return { ok: true, length: answer.length };
    } catch (error) {
      return fail(error);
    }
  },
  // The chat's options bar (below the thread, beside Send): the user drives the
  // model and whether the CLI loads their MCP servers. A partial merge onto the
  // persisted llm config — provider/apiKey (set in Settings) are left untouched —
  // so the very next run-prompt uses the chosen model / MCP policy (chat reads
  // appSettings.llm). Pilotable: an agent can flip the model over the socket.
  "set-chat-options": (ctx, params) => {
    const { model, loadMcp } = params ?? {};
    if (model !== void 0 && typeof model !== "string") {
      return { ok: false, error: '"model" must be a string' };
    }
    if (loadMcp !== void 0 && typeof loadMcp !== "boolean") {
      return { ok: false, error: '"loadMcp" must be a boolean' };
    }
    try {
      const current = ctx.getSettings().llm;
      const next = { ...current };
      if (model !== void 0) {
        if (model.trim() === "") delete next.model;
        else next.model = model.trim();
      }
      if (loadMcp !== void 0) next.loadMcp = loadMcp;
      const saved = ctx.setLlmConfig(next).llm;
      return { ok: true, model: saved.model ?? "", loadMcp: saved.loadMcp === true };
    } catch (error) {
      return fail(error);
    }
  }
};
const permissionCommands = {
  "list-permissions": (ctx) => {
    try {
      return { ok: true, grants: ctx.listPermissions() };
    } catch (error) {
      return fail(error);
    }
  },
  "clear-permissions": (ctx) => {
    try {
      const { cleared } = ctx.clearPermissions();
      return { ok: true, cleared };
    } catch (error) {
      return fail(error);
    }
  },
  // Open the OS Location Services pane. Fired automatically when location is
  // genuinely denied (see geolocation.ts), and available on the bus for the
  // socket / MCP too.
  "open-location-settings": (ctx) => {
    try {
      const { opened } = ctx.openLocationSettings();
      return { ok: true, opened };
    } catch (error) {
      return fail(error);
    }
  },
  // Read the real macOS location authorization for Mira. Powers the Settings UI
  // and is pilotable from the socket / MCP.
  "location-auth-status": (ctx) => {
    try {
      return { ok: true, status: ctx.locationAuthStatus() };
    } catch (error) {
      return fail(error);
    }
  },
  // Fire the native macOS "Mira would like to use your location" prompt (a no-op
  // unless the status is not-determined). Returns the resulting status.
  "request-location-authorization": (ctx) => {
    try {
      return { ok: true, status: ctx.requestLocationAuthorization() };
    } catch (error) {
      return fail(error);
    }
  }
};
const profileCommands = {
  "open-profile": (ctx, params) => {
    const { id } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") {
      return { ok: false, error: 'missing "id"' };
    }
    try {
      const { id: opened, created } = ctx.openProfile(id.trim());
      return { ok: true, id: opened, created };
    } catch (error) {
      return fail(error);
    }
  },
  "close-profile": (ctx, params) => {
    const { id } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") {
      return { ok: false, error: 'missing "id"' };
    }
    try {
      const { id: closedId, closed } = ctx.closeProfile(id.trim());
      return { ok: true, id: closedId, closed };
    } catch (error) {
      return fail(error);
    }
  },
  "create-profile": (ctx, params) => {
    const { label } = params ?? {};
    if (label !== void 0 && typeof label !== "string") {
      return { ok: false, error: '"label" must be a string' };
    }
    try {
      const { id, label: created } = ctx.createProfile(label?.trim() || void 0);
      return { ok: true, id, label: created };
    } catch (error) {
      return fail(error);
    }
  },
  "rename-profile": (ctx, params) => {
    const { id, label } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") {
      return { ok: false, error: 'missing "id"' };
    }
    if (typeof label !== "string" || label.trim() === "") {
      return { ok: false, error: 'missing "label"' };
    }
    try {
      const renamed = ctx.renameProfile(id.trim(), label.trim());
      return { ok: true, id: renamed.id, label: renamed.label };
    } catch (error) {
      return fail(error);
    }
  },
  "set-profile-color": (ctx, params) => {
    const { id, color } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") {
      return { ok: false, error: 'missing "id"' };
    }
    if (color !== void 0 && color !== null && typeof color !== "string") {
      return { ok: false, error: '"color" must be a string or null' };
    }
    try {
      const updated = ctx.setProfileColor(id.trim(), color ? color.trim() : null);
      return { ok: true, id: updated.id, color: updated.color ?? null };
    } catch (error) {
      return fail(error);
    }
  },
  "list-profiles": (ctx) => {
    const { profiles, focused } = ctx.listProfiles();
    return { ok: true, profiles, focused };
  },
  whoami: (ctx) => {
    return { ok: true, profile: ctx.getTargetProfile() };
  }
};
const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const LLM_PROVIDERS = ["claude-cli", "anthropic-api", "extractive"];
function composePrompt(systemPrompt, text) {
  return `${systemPrompt.trim()}

---

${text.trim()}`;
}
function buildAnthropicRequest(config, systemPrompt, text) {
  if (!config.apiKey || config.apiKey.trim() === "") {
    throw new Error("Anthropic API key is not set (Settings → AI)");
  }
  return {
    url: "https://api.anthropic.com/v1/messages",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: {
      model: config.model?.trim() || DEFAULT_ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: text }]
    }
  };
}
function parseAnthropicResponse(json) {
  if (!json || typeof json !== "object") throw new Error("empty LLM response");
  const obj = json;
  if (obj.type === "error") {
    const err = obj.error;
    throw new Error(err?.message ? `Anthropic API: ${err.message}` : "Anthropic API error");
  }
  const content = obj.content;
  if (!Array.isArray(content)) throw new Error("LLM response has no content");
  const text = content.map((block) => block && typeof block === "object" ? block.text : "").filter((t) => typeof t === "string").join("").trim();
  if (text === "") throw new Error("LLM returned no text");
  return text;
}
function buildClaudeCliArgs(config) {
  const args = ["-p"];
  if (!config.loadMcp) args.push(...chatClampArgs());
  if (config.model && config.model.trim() !== "") args.push("--model", config.model.trim());
  return args;
}
const CHAT_WEB_TOOLS = "WebSearch,WebFetch";
function chatClampArgs() {
  return [
    "--strict-mcp-config",
    "--tools",
    CHAT_WEB_TOOLS,
    "--allowedTools",
    CHAT_WEB_TOOLS,
    "--append-system-prompt",
    CHAT_WEB_ONLY_PROMPT
  ];
}
const CHAT_SYSTEM_PROMPT = "You are a helpful assistant embedded in a web browser. Answer the user's questions clearly and concisely. Use the current page (its URL and its text) as the context for the conversation.";
const CHAT_WEB_ONLY_PROMPT = "You are a chat assistant embedded in a web browser. You have exactly two tools: WebSearch (to search the web) and WebFetch (to read a URL). Use them when a question needs current or external information beyond the conversation and the provided page context. You have NO other tools: no shell, no filesystem, and no ability to control the browser. If asked to do something outside answering and web lookups, say so plainly in one sentence.";
function chatSystemPrompt(url2, pageText) {
  const parts = [CHAT_SYSTEM_PROMPT];
  if (url2.trim() !== "") parts.push(`Current page URL: ${url2.trim()}`);
  const t = pageText.trim();
  if (t !== "") parts.push(`Page content:

${t}`);
  return parts.join("\n\n---\n\n");
}
function parseDataUrl(dataUrl) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl.trim());
  return m ? { mediaType: m[1], data: m[2] } : null;
}
function imageBlock(screenshot) {
  const img = parseDataUrl(screenshot);
  return img ? { type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } } : null;
}
function buildAnthropicChatRequest(config, systemPrompt, messages, screenshot) {
  if (!config.apiKey || config.apiKey.trim() === "") {
    throw new Error("Anthropic API key is not set (Settings → AI)");
  }
  const img = screenshot ? imageBlock(screenshot) : null;
  return {
    url: "https://api.anthropic.com/v1/messages",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: {
      model: config.model?.trim() || DEFAULT_ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: messages.map((m, i) => {
        if (img && m.role === "user" && i === messages.length - 1) {
          return { role: m.role, content: [img, { type: "text", text: m.text }] };
        }
        return { role: m.role, content: m.text };
      })
    }
  };
}
function composeChatPrompt(systemPrompt, messages) {
  const transcript = messages.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text.trim()}`).join("\n\n");
  return `${systemPrompt.trim()}

---

${transcript}

Assistant:`;
}
function buildClaudeStreamArgs(config) {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose"
  ];
  if (!config.loadMcp) args.push(...chatClampArgs());
  if (config.model && config.model.trim() !== "") args.push("--model", config.model.trim());
  return args;
}
function buildClaudeStreamInput(systemPrompt, messages, screenshot) {
  const text = composeChatPrompt(systemPrompt, messages);
  const img = imageBlock(screenshot);
  const content = img ? [img, { type: "text", text }] : [{ type: "text", text }];
  return JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
}
function parseClaudeStreamResult(stdout) {
  let result = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj.type === "result") result = obj;
    } catch {
    }
  }
  if (!result) throw new Error("claude CLI returned no result");
  if (result.is_error || result.subtype !== "success") {
    throw new Error(result.result?.trim() || "claude CLI error");
  }
  const text = (result.result ?? "").trim();
  if (text === "") throw new Error("claude CLI returned no output");
  return text;
}
const settingsCommands = {
  // Open the Settings surface, optionally on a specific sub-section (the same
  // names as the panel's tabs: 'general', 'ai', 'profiles', 'extensions',
  // 'permissions', 'data'). Unknown names fall back to the default section.
  "open-settings": (ctx, params) => {
    const { section } = params ?? {};
    if (section !== void 0 && typeof section !== "string") {
      return { ok: false, error: '"section" must be a string' };
    }
    try {
      ctx.openSettings(section);
      return { ok: true };
    } catch (error) {
      return fail(error);
    }
  },
  "get-settings": (ctx) => {
    return { ok: true, ...ctx.getSettings() };
  },
  // Set the home page URL. Normalized like the address bar (bare host → https://…)
  // so "example.com" is stored as a real URL. An empty value clears the home so
  // new tabs open blank. Pilotable: usable from the socket / MCP, not only the
  // Settings UI.
  "set-home-url": (ctx, params) => {
    const { url: url2 } = params ?? {};
    if (typeof url2 !== "string") return { ok: false, error: '"url" must be a string' };
    const normalized = url2.trim() === "" ? "" : normalizeInput(url2);
    try {
      const settings = ctx.setHomeUrl(normalized);
      return { ok: true, homeUrl: settings.homeUrl };
    } catch (error) {
      return fail(error);
    }
  },
  // Choose the AI engine skills use (provider + optional key/model). Pilotable:
  // usable from the socket / MCP, not only the Settings UI.
  "set-llm-config": (ctx, params) => {
    const { provider, apiKey, model } = params ?? {};
    if (!LLM_PROVIDERS.includes(provider)) {
      return { ok: false, error: `"provider" must be one of: ${LLM_PROVIDERS.join(", ")}` };
    }
    if (apiKey !== void 0 && typeof apiKey !== "string") {
      return { ok: false, error: '"apiKey" must be a string' };
    }
    if (model !== void 0 && typeof model !== "string") {
      return { ok: false, error: '"model" must be a string' };
    }
    try {
      const settings = ctx.setLlmConfig({ provider, apiKey, model });
      return { ok: true, llm: settings.llm };
    } catch (error) {
      return fail(error);
    }
  },
  // Resize the left tab panel. The width is clamped by the context (via
  // clampWidth); the chrome sends the drag width, main lays out the web view to
  // match. Pilotable from the socket / MCP too.
  "set-sidebar-width": (ctx, params) => {
    const { width } = params ?? {};
    if (typeof width !== "number") return { ok: false, error: '"width" must be a number' };
    try {
      const settings = ctx.setSidebarWidth(width);
      return { ok: true, sidebarWidth: settings.sidebarWidth };
    } catch (error) {
      return fail(error);
    }
  },
  // Resize the right skill pane (same contract as set-sidebar-width).
  "set-skill-pane-width": (ctx, params) => {
    const { width } = params ?? {};
    if (typeof width !== "number") return { ok: false, error: '"width" must be a number' };
    try {
      const settings = ctx.setSkillPaneWidth(width);
      return { ok: true, skillPaneWidth: settings.skillPaneWidth };
    } catch (error) {
      return fail(error);
    }
  }
};
function promptTitle(prompt) {
  const t = prompt.trim();
  return t.length > 60 ? `${t.slice(0, 57)}…` : t;
}
const skillsCommands = {
  "list-skills": (ctx) => {
    const url2 = ctx.activeUrl();
    const skills = resolveSkills(url2 ?? "");
    return { ok: true, url: url2, skills: skills.map((s) => ({ id: s.id, name: s.name })) };
  },
  "run-skill": async (ctx, params) => {
    const { id } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") {
      return { ok: false, error: 'missing "id"' };
    }
    const url2 = ctx.activeUrl();
    const skill = resolveSkills(url2 ?? "").find((s) => s.id === id);
    if (!skill) return { ok: false, error: `skill not applicable here: ${id}` };
    const usePane = skill.sink.kind === "pane";
    const pane = usePane ? ctx.getSkillPane() : null;
    const title = pane?.title || skill.name;
    const withUser = pane ? [...pane.messages, { role: "user", text: skill.name }] : [];
    if (usePane) ctx.showSkillPane({ open: true, title, status: "loading", messages: withUser });
    try {
      const text = await ctx.extractText(skill.source);
      if (text.trim() === "") {
        const error = "no page content to summarize";
        if (usePane) {
          ctx.showSkillPane({ open: true, title, status: "error", messages: withUser, error });
        }
        return { ok: false, error };
      }
      const summary = await ctx.summarize(skill.prompt, text);
      if (usePane) {
        ctx.showSkillPane({
          open: true,
          title,
          status: "idle",
          messages: [...withUser, { role: "assistant", text: summary }]
        });
      }
      return { ok: true, skill: skill.id, name: skill.name, sink: skill.sink.kind, summary };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (usePane) {
        ctx.showSkillPane({
          open: true,
          title,
          status: "error",
          messages: withUser,
          error: message
        });
      }
      return fail(error);
    }
  },
  // Free-form prompt from the pane's input: a chat turn. Append the question to the
  // conversation, answer it with the current page's text as context (best-effort —
  // a page that yields no text just becomes a plain question) AND the prior turns,
  // then append the answer.
  "run-prompt": async (ctx, params) => {
    const { prompt, withScreenshot } = params ?? {};
    if (typeof prompt !== "string" || prompt.trim() === "") {
      return { ok: false, error: 'missing "prompt"' };
    }
    const pane = ctx.getSkillPane();
    const title = pane.title || promptTitle(prompt);
    const withUser = [...pane.messages, { role: "user", text: prompt.trim() }];
    ctx.showSkillPane({ open: true, title, status: "loading", messages: withUser });
    try {
      const url2 = ctx.activeUrl() ?? "";
      let text = "";
      try {
        text = await ctx.extractText({ kind: "readability" });
      } catch {
        text = "";
      }
      let screenshot;
      if (withScreenshot === true) {
        try {
          screenshot = await ctx.capturePage() ?? void 0;
        } catch {
          screenshot = void 0;
        }
      }
      const answer = await ctx.chat(withUser, { url: url2, text, ...screenshot ? { screenshot } : {} });
      ctx.showSkillPane({
        open: true,
        title,
        status: "idle",
        messages: [...withUser, { role: "assistant", text: answer }]
      });
      return { ok: true, text: answer };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.showSkillPane({ open: true, title, status: "error", messages: withUser, error: message });
      return fail(error);
    }
  }
};
const spacesCommands = {
  "list-spaces": (ctx) => {
    try {
      const state = ctx.getSpacesState();
      return { ok: true, displays: state.displays, window: state.window };
    } catch (error) {
      return fail(error);
    }
  },
  "move-window-to-space": (ctx, params) => {
    const { spaceIndex } = params ?? {};
    if (typeof spaceIndex !== "number" || !Number.isInteger(spaceIndex) || spaceIndex < 0) {
      return { ok: false, error: '"spaceIndex" must be a non-negative integer' };
    }
    try {
      const outcome = ctx.moveTargetWindowToSpace(spaceIndex);
      return { ok: true, spaceIndex, moved: outcome === "moved" };
    } catch (error) {
      return fail(error);
    }
  }
};
function formatMemory(m) {
  const mb = m.rss / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}
function formatTabs(c) {
  return `${c.loaded}/${c.total}`;
}
const statusCommands = {
  "get-status": (ctx) => {
    const memory = ctx.getMemoryUsage();
    const tabs = ctx.getTabCounts();
    return {
      ok: true,
      memory,
      memoryText: formatMemory(memory),
      tabs,
      tabsText: formatTabs(tabs)
    };
  }
};
const tabFoldersCommands = {
  "list-tab-folders": (ctx) => {
    const { folders } = ctx.listTabFolders();
    return { ok: true, folders };
  },
  "create-tab-folder": (ctx, params) => {
    const { title, tabId } = params ?? {};
    if (typeof title !== "string" || title.trim() === "") {
      return { ok: false, error: 'missing "title"' };
    }
    if (tabId !== void 0 && (typeof tabId !== "string" || tabId.trim() === "")) {
      return { ok: false, error: '"tabId" must be a non-empty string' };
    }
    try {
      const { id } = ctx.createTabFolder(title.trim(), tabId?.trim());
      return { ok: true, id };
    } catch (error) {
      return fail(error);
    }
  },
  "rename-tab-folder": (ctx, params) => {
    const { id, title } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") return { ok: false, error: 'missing "id"' };
    if (typeof title !== "string" || title.trim() === "") {
      return { ok: false, error: 'missing "title"' };
    }
    try {
      const { renamed } = ctx.renameTabFolder(id.trim(), title.trim());
      return { ok: true, renamed };
    } catch (error) {
      return fail(error);
    }
  },
  "remove-tab-folder": (ctx, params) => {
    const { id } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") return { ok: false, error: 'missing "id"' };
    try {
      const { removed } = ctx.removeTabFolder(id.trim());
      return { ok: true, removed };
    } catch (error) {
      return fail(error);
    }
  },
  "toggle-tab-folder": (ctx, params) => {
    const { id, collapsed } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") return { ok: false, error: 'missing "id"' };
    if (collapsed !== void 0 && typeof collapsed !== "boolean") {
      return { ok: false, error: '"collapsed" must be a boolean' };
    }
    try {
      const result = ctx.toggleTabFolder(id.trim(), collapsed);
      return { ok: true, collapsed: result.collapsed };
    } catch (error) {
      return fail(error);
    }
  },
  "set-tab-folder-color": (ctx, params) => {
    const { id, color } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") return { ok: false, error: 'missing "id"' };
    if (color !== null && (typeof color !== "string" || color.trim() === "")) {
      return { ok: false, error: '"color" must be a non-empty string or null' };
    }
    try {
      const { updated } = ctx.setTabFolderColor(id.trim(), color === null ? null : color.trim());
      return { ok: true, updated };
    } catch (error) {
      return fail(error);
    }
  },
  "move-tab-to-folder": (ctx, params) => {
    const { tabId, folderId } = params ?? {};
    if (typeof tabId !== "string" || tabId.trim() === "") {
      return { ok: false, error: 'missing "tabId"' };
    }
    if (folderId !== null && (typeof folderId !== "string" || folderId.trim() === "")) {
      return { ok: false, error: '"folderId" must be a non-empty string or null' };
    }
    try {
      const { moved } = ctx.moveTabToFolder(
        tabId.trim(),
        folderId === null ? null : folderId.trim()
      );
      return { ok: true, moved };
    } catch (error) {
      return fail(error);
    }
  }
};
const tabDetachCommands = {
  "detach-tab": async (ctx, params) => {
    const { id, x, y } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") {
      return { ok: false, error: 'missing "id"' };
    }
    const hasX = typeof x === "number" && Number.isFinite(x);
    const hasY = typeof y === "number" && Number.isFinite(y);
    if (hasX !== hasY) {
      return { ok: false, error: '"x" and "y" must be given together' };
    }
    try {
      const result = await ctx.detachTab(id.trim(), hasX && hasY ? { x, y } : void 0);
      return { ok: true, ...result };
    } catch (error) {
      return fail(error);
    }
  },
  "move-tab-to-window": (ctx, params) => {
    const { id, windowId } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") {
      return { ok: false, error: 'missing "id"' };
    }
    if (typeof windowId !== "string" || windowId.trim() === "") {
      return { ok: false, error: 'missing "windowId"' };
    }
    try {
      const result = ctx.moveTabToWindow(id.trim(), windowId.trim());
      return { ok: true, ...result };
    } catch (error) {
      return fail(error);
    }
  },
  "activate-tab": (ctx, params) => {
    const { id } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") {
      return { ok: false, error: 'missing "id"' };
    }
    try {
      const result = ctx.activateTab(id.trim());
      return { ok: true, ...result };
    } catch (error) {
      return fail(error);
    }
  },
  "list-windows": (ctx) => {
    return { ok: true, windows: ctx.listWindows() };
  }
};
function rankTabMemory(entries) {
  return [...entries].sort(
    (a, b) => b.processMemoryBytes - a.processMemoryBytes || a.title.localeCompare(b.title) || a.tabId.localeCompare(b.tabId)
  );
}
function totalDistinctMemory(entries) {
  const seen = /* @__PURE__ */ new Map();
  for (const e of entries) seen.set(e.pid, e.processMemoryBytes);
  let total = 0;
  for (const bytes of seen.values()) total += bytes;
  return total;
}
const tabMemoryCommands = {
  // Cross-profile: reports every loaded tab of every open window, ranked by the
  // memory of its renderer process. The heaviest tabs sit at the top.
  "list-tab-memory": (ctx) => {
    const report = ctx.listTabMemory();
    return { ok: true, ...report };
  }
};
const tabMenuCommands = {
  // The sidebar's right-click on a tab: pop the native tab menu for `tabId`. The
  // native popup appears at the cursor and composites above the WebContentsView.
  "show-tab-menu": (ctx, params) => {
    const { tabId } = params ?? {};
    if (typeof tabId !== "string" || tabId.trim() === "") {
      return { ok: false, error: 'missing "tabId"' };
    }
    try {
      ctx.showTabMenu(tabId.trim());
      return { ok: true };
    } catch (error) {
      return fail(error);
    }
  }
};
const tabsCommands = {
  "new-tab": (ctx, params) => {
    const { url: url2, background } = params ?? {};
    if (url2 !== void 0 && typeof url2 !== "string") {
      return { ok: false, error: '"url" must be a string' };
    }
    if (background !== void 0 && typeof background !== "boolean") {
      return { ok: false, error: '"background" must be a boolean' };
    }
    try {
      const tab = ctx.newTab(url2?.trim() || void 0, background === true);
      return { ok: true, ...tab };
    } catch (error) {
      return fail(error);
    }
  },
  "close-tab": (ctx, params) => {
    const { id } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") {
      return { ok: false, error: 'missing "id"' };
    }
    try {
      ctx.closeTab(id.trim());
      return { ok: true, id: id.trim() };
    } catch (error) {
      return fail(error);
    }
  },
  // The Cmd+Shift+D target: duplicate the active web tab in place, no id needed.
  // A no-op (duplicated:false) on the Settings tab or when nothing is active.
  "duplicate-active-tab": (ctx) => {
    try {
      const result = ctx.duplicateActiveTab();
      return { ok: true, ...result };
    } catch (error) {
      return fail(error);
    }
  },
  // The Cmd+W target: close whatever tab is active, no id needed. On a pinned
  // tab the first press only arms it (armed:true); pressing again closes.
  "close-active-tab": (ctx) => {
    try {
      const result = ctx.closeActiveTab();
      return { ok: true, ...result };
    } catch (error) {
      return fail(error);
    }
  },
  // Discard a specific tab's page (id) but keep the tab: frees its renderer
  // process while leaving it in the strip, ready to reload when selected.
  "discard-tab": (ctx, params) => {
    const { id } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") {
      return { ok: false, error: 'missing "id"' };
    }
    try {
      const { discarded } = ctx.discardTab(id.trim());
      return { ok: true, discarded, id: id.trim() };
    } catch (error) {
      return fail(error);
    }
  },
  // The Cmd+S target: put the active tab's page to sleep to reclaim its RAM, keep
  // the tab, and move to the next tab. Unlike close-active-tab, the tab stays.
  "discard-active-tab": (ctx) => {
    try {
      const { discarded, id } = ctx.discardActiveTab();
      return { ok: true, discarded, id };
    } catch (error) {
      return fail(error);
    }
  },
  // The Cmd+Shift+A target: re-open every tab that was awake when Mira last quit
  // (restore only wakes the active one). A no-op (woken:0) when they are already
  // all awake or the window was opened fresh.
  "wake-all-tabs": (ctx) => {
    try {
      const { woken } = ctx.wakeAllTabs();
      return { ok: true, woken };
    } catch (error) {
      return fail(error);
    }
  },
  "select-tab": (ctx, params) => {
    const { id } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") {
      return { ok: false, error: 'missing "id"' };
    }
    try {
      const { id: selected } = ctx.selectTab(id.trim());
      return { ok: true, id: selected };
    } catch (error) {
      return fail(error);
    }
  },
  // Cmd+Up: step to the previous tab in the vertical strip (asleep or not).
  "prev-tab": (ctx) => {
    try {
      const { id } = ctx.selectPrevTab();
      return { ok: true, id };
    } catch (error) {
      return fail(error);
    }
  },
  // Cmd+Down: step to the next tab in the vertical strip (asleep or not).
  "next-tab": (ctx) => {
    try {
      const { id } = ctx.selectNextTab();
      return { ok: true, id };
    } catch (error) {
      return fail(error);
    }
  },
  // Cmd+Alt+Left: go back through the tabs you've looked at (focus history),
  // not the strip order. A no-op (id:null) at the oldest viewed tab.
  "recent-tab-back": (ctx) => {
    try {
      const { id } = ctx.recentTabBack();
      return { ok: true, id };
    } catch (error) {
      return fail(error);
    }
  },
  // Cmd+Alt+Right: go forward again through the focus history after stepping back.
  "recent-tab-forward": (ctx) => {
    try {
      const { id } = ctx.recentTabForward();
      return { ok: true, id };
    } catch (error) {
      return fail(error);
    }
  },
  // Pin a tab into the square grid at the head of the strip. To close a pinned
  // tab from the keyboard, press Cmd+W twice in a row (see close-active-tab);
  // an explicit close-tab by id still closes it immediately.
  "pin-tab": (ctx, params) => {
    const { id } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") {
      return { ok: false, error: 'missing "id"' };
    }
    try {
      const result = ctx.pinTab(id.trim());
      return { ok: true, ...result };
    } catch (error) {
      return fail(error);
    }
  },
  // Unpin a tab: it drops back to the head of the regular list.
  "unpin-tab": (ctx, params) => {
    const { id } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") {
      return { ok: false, error: 'missing "id"' };
    }
    try {
      const result = ctx.unpinTab(id.trim());
      return { ok: true, ...result };
    } catch (error) {
      return fail(error);
    }
  },
  // The tab context-menu "Keep Awake" / "Stop Keeping Awake" toggle: mark a tab so
  // it never sleeps — woken in the background on restore, immune to discard. The
  // caller passes the target state explicitly (the menu already knows it), so this
  // is idempotent and pilotable from the socket / MCP.
  "set-tab-awake": (ctx, params) => {
    const { id, keepAwake } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") {
      return { ok: false, error: 'missing "id"' };
    }
    if (typeof keepAwake !== "boolean") {
      return { ok: false, error: '"keepAwake" must be a boolean' };
    }
    try {
      const result = ctx.setTabKeepAwake(id.trim(), keepAwake);
      return { ok: true, ...result };
    } catch (error) {
      return fail(error);
    }
  },
  "move-tab": (ctx, params) => {
    const { id, toIndex } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") {
      return { ok: false, error: 'missing "id"' };
    }
    if (typeof toIndex !== "number" || !Number.isInteger(toIndex)) {
      return { ok: false, error: '"toIndex" must be an integer' };
    }
    try {
      const { id: moved } = ctx.moveTab(id.trim(), toIndex);
      return { ok: true, id: moved, toIndex };
    } catch (error) {
      return fail(error);
    }
  },
  // The Cmd+Shift+T target: bring back the last tab closed in this window. A no-op
  // (reopened:false) when nothing was closed since the window opened.
  "reopen-closed-tab": (ctx) => {
    try {
      const result = ctx.reopenClosedTab();
      return { ok: true, ...result };
    } catch (error) {
      return fail(error);
    }
  },
  // Copy a tab's id to the OS clipboard (the tab context-menu "Copy Tab ID"): the
  // id is what every id-taking command / exec-js needs, so this hands it straight
  // to a shell or agent piloting Mira. Pilotable too — the socket can grab an id.
  "copy-tab-id": (ctx, params) => {
    const { id } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") {
      return { ok: false, error: 'missing "id"' };
    }
    try {
      ctx.writeClipboard(id.trim());
      ctx.showToast("Copied!");
      return { ok: true, id: id.trim() };
    } catch (error) {
      return fail(error);
    }
  },
  // Copy the ACTIVE tab's url to the OS clipboard (fired when the address bar takes
  // focus, so grabbing the current address costs one click). Stays a command so a
  // socket / MCP client can lift the url too. Refuses with ok:false when there is
  // no active tab or it has no url yet (a fresh empty tab): copying '' and then
  // toasting "Copied!" would flash a lie.
  "copy-active-url": (ctx) => {
    try {
      const { tabs, activeId } = ctx.listTabs();
      const url2 = tabs.find((t) => t.id === activeId)?.url.trim() ?? "";
      if (url2 === "") return { ok: false, error: "no url to copy" };
      ctx.writeClipboard(url2);
      ctx.showToast("Copied!");
      return { ok: true, url: url2 };
    } catch (error) {
      return fail(error);
    }
  },
  "list-tabs": (ctx) => {
    const { tabs, activeId, panelCollapsed } = ctx.listTabs();
    return { ok: true, tabs, activeId, panelCollapsed };
  },
  "toggle-tabs-panel": (ctx, params) => {
    const { collapsed } = params ?? {};
    if (collapsed !== void 0 && typeof collapsed !== "boolean") {
      return { ok: false, error: '"collapsed" must be a boolean' };
    }
    try {
      const result = ctx.toggleTabsPanel(collapsed);
      return { ok: true, collapsed: result.collapsed };
    } catch (error) {
      return fail(error);
    }
  }
};
const themeCommands = {
  "list-themes": (ctx) => {
    return { ok: true, themes: ctx.listThemes() };
  },
  "create-theme": (ctx, params) => {
    const p = params ?? {};
    if (typeof p.name !== "string" || p.name.trim() === "") {
      return { ok: false, error: 'missing "name"' };
    }
    if (typeof p.background !== "string" || typeof p.text !== "string") {
      return { ok: false, error: '"background" and "text" are required color strings' };
    }
    try {
      const theme = ctx.createTheme({
        name: p.name,
        background: p.background,
        text: p.text,
        accent: p.accent ?? null,
        wallpaper: p.wallpaper ?? null
      });
      return { ok: true, theme };
    } catch (error) {
      return fail(error);
    }
  },
  "update-theme": (ctx, params) => {
    const p = params ?? {};
    if (typeof p.id !== "string" || p.id.trim() === "") {
      return { ok: false, error: 'missing "id"' };
    }
    try {
      const theme = ctx.updateTheme(p.id.trim(), {
        ...p.name !== void 0 ? { name: p.name } : {},
        ...p.background !== void 0 ? { background: p.background } : {},
        ...p.text !== void 0 ? { text: p.text } : {},
        ...p.accent !== void 0 ? { accent: p.accent } : {},
        ...p.wallpaper !== void 0 ? { wallpaper: p.wallpaper } : {}
      });
      return { ok: true, theme };
    } catch (error) {
      return fail(error);
    }
  },
  "delete-theme": (ctx, params) => {
    const { id } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") {
      return { ok: false, error: 'missing "id"' };
    }
    try {
      return { ok: true, ...ctx.deleteTheme(id.trim()) };
    } catch (error) {
      return fail(error);
    }
  },
  "set-profile-theme": (ctx, params) => {
    const { id, themeId } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") {
      return { ok: false, error: 'missing "id"' };
    }
    if (themeId !== void 0 && themeId !== null && typeof themeId !== "string") {
      return { ok: false, error: '"themeId" must be a string or null' };
    }
    try {
      const updated = ctx.setProfileTheme(id.trim(), themeId ? themeId.trim() : null);
      return { ok: true, id: updated.id, themeId: updated.themeId ?? null };
    } catch (error) {
      return fail(error);
    }
  }
};
const toastCommands = {
  // Pop a transient toast pill. Fired by other commands (copy-tab-id → "Copied!")
  // and available on the bus so a socket / MCP client can flash a message too.
  "show-toast": (ctx, params) => {
    const { message } = params ?? {};
    if (typeof message !== "string" || message.trim() === "") {
      return { ok: false, error: 'missing "message"' };
    }
    try {
      ctx.showToast(message.trim());
      return { ok: true };
    } catch (error) {
      return fail(error);
    }
  }
};
function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}
function isRect(v) {
  if (typeof v !== "object" || v === null) return false;
  const r = v;
  return isFiniteNumber(r.x) && isFiniteNumber(r.y) && isFiniteNumber(r.width) && isFiniteNumber(r.height);
}
const tooltipCommands = {
  "show-tooltip": (ctx, params) => {
    const { text, anchor } = params ?? {};
    if (typeof text !== "string" || text.trim() === "")
      return { ok: false, error: 'missing "text"' };
    if (!isRect(anchor)) {
      return { ok: false, error: '"anchor" must have finite x, y, width, height' };
    }
    try {
      const { shown } = ctx.showTooltip(text, anchor);
      return { ok: true, shown };
    } catch (error) {
      return fail(error);
    }
  },
  "hide-tooltip": (ctx) => {
    try {
      const { hidden } = ctx.hideTooltip();
      return { ok: true, hidden };
    } catch (error) {
      return fail(error);
    }
  }
};
function isProfileColor(value) {
  return typeof value === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);
}
const DEFAULT_PROFILE_ID = "default";
const DEFAULT_PROFILE_LABEL = "Default";
function partitionForId(id) {
  return id === DEFAULT_PROFILE_ID ? void 0 : `persist:mira-${id}`;
}
function defaultProfiles() {
  return [{ id: DEFAULT_PROFILE_ID, label: DEFAULT_PROFILE_LABEL }];
}
function normalizeProfiles(raw) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const list = Array.isArray(raw) ? raw : [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const { id, label, themeId, color, encrypted } = item;
    if (typeof id !== "string" || id.trim() === "") continue;
    if (typeof label !== "string" || label.trim() === "") continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      label: label.trim(),
      ...typeof themeId === "string" && themeId.trim() !== "" ? { themeId: themeId.trim() } : {},
      ...isProfileColor(color) ? { color } : {},
      ...encrypted === true ? { encrypted: true } : {}
    });
  }
  const def = out.find((p) => p.id === DEFAULT_PROFILE_ID) ?? {
    id: DEFAULT_PROFILE_ID,
    label: DEFAULT_PROFILE_LABEL
  };
  return [def, ...out.filter((p) => p.id !== DEFAULT_PROFILE_ID)];
}
function findById(profiles, id) {
  return profiles.find((p) => p.id === id);
}
function renameProfile(profiles, id, label) {
  const trimmed = label.trim();
  if (trimmed === "") throw new Error("empty label");
  if (!findById(profiles, id)) throw new Error(`unknown profile: ${id}`);
  return profiles.map((p) => p.id === id ? { ...p, label: trimmed } : p);
}
function addProfile(profiles, profile) {
  const label = profile.label.trim();
  if (profile.id.trim() === "") throw new Error("empty id");
  if (label === "") throw new Error("empty label");
  if (findById(profiles, profile.id)) throw new Error(`duplicate profile: ${profile.id}`);
  return [
    ...profiles,
    { id: profile.id, label, ...profile.color ? { color: profile.color } : {} }
  ];
}
function setProfileColor(profiles, id, color) {
  if (!findById(profiles, id)) throw new Error(`unknown profile: ${id}`);
  if (color !== null && !isProfileColor(color)) throw new Error(`invalid color: ${color}`);
  return profiles.map((p) => {
    if (p.id !== id) return p;
    const { color: _dropped, ...rest } = p;
    return color === null ? rest : { ...rest, color };
  });
}
function setProfileTheme(profiles, id, themeId) {
  if (!findById(profiles, id)) throw new Error(`unknown profile: ${id}`);
  const trimmed = themeId?.trim() || null;
  return profiles.map((p) => {
    if (p.id !== id) return p;
    const { themeId: _t, color: _c, ...rest } = p;
    return trimmed ? { ...rest, themeId: trimmed } : rest;
  });
}
function nextProfileLabel(profiles) {
  const labels = new Set(profiles.map((p) => p.label));
  let n = 2;
  while (labels.has(`Profile ${n}`)) n++;
  return `Profile ${n}`;
}
function parseProfileArg(argv, env) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--profile") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) return next.trim() || null;
    } else if (arg.startsWith("--profile=")) {
      return arg.slice("--profile=".length).trim() || null;
    }
  }
  const fromEnv = env.MIRA_PROFILE?.trim();
  return fromEnv ? fromEnv : null;
}
function assertEncryptable(profileId) {
  if (profileId === DEFAULT_PROFILE_ID) {
    throw new Error("the default profile cannot be encrypted");
  }
  if (profileId.trim() === "") throw new Error("missing profile id");
}
function partitionDirName(profileId) {
  const partition = partitionForId(profileId);
  return partition ? partition.replace(/^persist:/, "") : `mira-${profileId}`;
}
function noncePartitionDir(profileId, nonce) {
  return `${partitionDirName(profileId)}-${nonce}`;
}
function isProfilePartitionDir(dirName, profileId) {
  const canonical = partitionDirName(profileId);
  return dirName === canonical || dirName.startsWith(`${canonical}-`);
}
function vaultPlan(userDataDir, profileId, partitionDir) {
  assertEncryptable(profileId);
  return {
    bundle: path.join(userDataDir, "vaults", `${profileId}.sparsebundle`),
    volumeName: `mira-${profileId}`,
    dirs: [
      { live: path.join(userDataDir, "profiles", profileId), name: "profiles" },
      {
        live: path.join(userDataDir, "Partitions", partitionDir ?? partitionDirName(profileId)),
        name: "partition"
      }
    ]
  };
}
function isValidVaultPassword(password) {
  return typeof password === "string" && password.length > 0;
}
function needsUnlock(profile, unlockedIds) {
  return profile.encrypted === true && !unlockedIds.has(profile.id);
}
const vaultCommands = {
  "encrypt-profile": async (ctx, params) => {
    const { id, password } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") return { ok: false, error: 'missing "id"' };
    if (!isValidVaultPassword(password)) return { ok: false, error: 'missing "password"' };
    try {
      const res = await ctx.encryptProfile(id.trim(), password);
      return { ok: true, id: res.id };
    } catch (error) {
      return fail(error);
    }
  },
  "unlock-profile": async (ctx, params) => {
    const { id, password } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") return { ok: false, error: 'missing "id"' };
    if (!isValidVaultPassword(password)) return { ok: false, error: 'missing "password"' };
    try {
      const res = await ctx.unlockProfile(id.trim(), password);
      return { ok: true, id: res.id };
    } catch (error) {
      return fail(error);
    }
  },
  "lock-profile": async (ctx, params) => {
    const { id } = params ?? {};
    if (typeof id !== "string" || id.trim() === "") return { ok: false, error: 'missing "id"' };
    try {
      const res = await ctx.lockProfile(id.trim());
      return { ok: true, id: res.id, locked: res.locked };
    } catch (error) {
      return fail(error);
    }
  },
  "lock-all-vaults": async (ctx) => {
    try {
      const { locked } = await ctx.lockAllVaults();
      return { ok: true, locked };
    } catch (error) {
      return fail(error);
    }
  },
  "list-vaults": (ctx) => {
    const { encrypted, unlocked } = ctx.listVaults();
    return { ok: true, encrypted, unlocked };
  }
};
function nextZen(zen, live, requested) {
  const target = requested ?? !zen.hidden;
  if (target === zen.hidden) return { zen, apply: live };
  if (target) {
    return {
      zen: { hidden: true, snapshot: { ...live } },
      apply: { tabsCollapsed: true, skillPaneOpen: false }
    };
  }
  const restore = zen.snapshot ?? live;
  return { zen: { hidden: false, snapshot: null }, apply: { ...restore } };
}
const zenCommands = {
  // Cmd+Shift+H (and the socket / MCP): hide or show the toolbar, status bar, and
  // both side panels together. `hidden` omitted → toggle; a boolean forces it.
  "toggle-zen": (ctx, params) => {
    const { hidden } = params ?? {};
    if (hidden !== void 0 && typeof hidden !== "boolean") {
      return { ok: false, error: '"hidden" must be a boolean' };
    }
    try {
      const result = ctx.toggleZen(hidden);
      return { ok: true, hidden: result.hidden };
    } catch (error) {
      return fail(error);
    }
  }
};
function createCommandRegistry() {
  const commands = {
    ...appCommands,
    ...audioCommands,
    ...bookmarksCommands,
    ...cookieCommands,
    ...devtoolsCommands,
    ...downloadsCommands,
    ...extensionsCommands,
    ...findCommands,
    ...folderMenuCommands,
    ...historyCommands,
    ...inputCommands,
    ...magnifierCommands,
    ...mediaCommands,
    ...navigationCommands,
    ...openCommands,
    ...paletteCommands,
    ...paneCommands,
    ...permissionCommands,
    ...profileCommands,
    ...settingsCommands,
    ...skillsCommands,
    ...spacesCommands,
    ...statusCommands,
    ...tabFoldersCommands,
    ...tabMemoryCommands,
    ...tabDetachCommands,
    ...tabMenuCommands,
    ...tabsCommands,
    ...themeCommands,
    ...toastCommands,
    ...tooltipCommands,
    ...vaultCommands,
    ...zenCommands
  };
  return buildRegistry(commands);
}
function handleRequestLine(line, registry, ctx) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
  const { command, cmd, params } = msg ?? {};
  const name = typeof command === "string" ? command : cmd;
  if (typeof name !== "string") {
    return { ok: false, error: 'missing "command" field' };
  }
  try {
    return registry.execute(name, params, ctx);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
function startCommandSocket(socketPath, registry, makeContext) {
  if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
  const server = net.createServer((conn) => {
    let buffer = "";
    let chain = Promise.resolve();
    const consume = (line) => {
      const trimmed = line.trim();
      if (trimmed === "") return;
      chain = chain.then(async () => {
        let response;
        try {
          response = await handleRequestLine(trimmed, registry, makeContext());
        } catch (error) {
          response = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        conn.write(JSON.stringify(response) + "\n");
      });
    };
    conn.on("data", (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        consume(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    });
    conn.on("end", () => {
      if (buffer.length > 0) consume(buffer);
    });
    conn.on("error", () => {
    });
  });
  server.listen(socketPath);
  return server;
}
function cleanupSocket(socketPath) {
  try {
    if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
  } catch {
  }
}
function forwardRequest(url2) {
  return JSON.stringify({ command: "open-url", params: { url: url2 } });
}
function forwardToRunningInstance(socketPath, urls, timeoutMs = 2e3) {
  if (urls.length === 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const conn = net.connect(socketPath);
    let settled = false;
    const finish = (accepted) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      resolve(accepted);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    conn.on("error", () => finish(false));
    conn.on("connect", () => {
      for (const url2 of urls) conn.write(forwardRequest(url2) + "\n");
    });
    let buffer = "";
    let replies = 0;
    conn.on("data", (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        buffer = buffer.slice(idx + 1);
        replies += 1;
        if (replies >= urls.length) finish(true);
      }
    });
  });
}
const CHROME_PARTITION = "persist:mira-chrome";
const DEFAULT_SESSION_ALIAS = "mira-default-session";
const PERMALINK_FN = String.raw`
function miraCleanPermalink(href) {
  // An X/Twitter status link often carries a /photo/N or /video/N (or query)
  // suffix pointing at one attachment; yt-dlp wants the canonical tweet URL, so
  // truncate to '.../status/<id>'. Other sites (YouTube watch?v=…) keep their URL.
  try {
    var m = href.match(/^(https?:\/\/[^\/]+\/[^\/]+\/status\/\d+)/);
    return m ? m[1] : href;
  } catch (e) { return href; }
}
function miraNearestPermalink(el) {
  try {
    var re = /\/status\/\d+|\/watch\b|youtu\.be\/|\/video\/|\/reel\/|\/shorts\//;
    var n = el;
    for (var depth = 0; n && depth < 20; depth++, n = n.parentElement) {
      if (n.tagName === 'A' && n.href && re.test(n.href)) return miraCleanPermalink(n.href);
      if (n.querySelectorAll) {
        var as = n.querySelectorAll('a[href]');
        for (var i = 0; i < as.length; i++) {
          if (as[i].href && re.test(as[i].href)) return miraCleanPermalink(as[i].href);
        }
      }
    }
  } catch (e) {}
  return (typeof location !== 'undefined' && location.href) || '';
}
`;
const MEDIA_COLLECT_SOURCE = String.raw`
(function () {
  try {
    ${PERMALINK_FN}
    var out = []
    var seen = Object.create(null)
    var MAX_ELEMENTS = 6000
    function push(rec) {
      if (!rec) return
      // Dedup by url within the DOM pass; a url-less video (no src yet) dedups by
      // its permalink so one <video> is not listed twice; a tainted canvas (no url,
      // no pageUrl) always passes.
      if (rec.url) { if (seen[rec.url]) return; seen[rec.url] = 1 }
      else if (rec.pageUrl) { var pk = 'p:' + rec.pageUrl; if (seen[pk]) return; seen[pk] = 1 }
      out.push(rec)
    }
    function abs(u) {
      if (!u) return ''
      try { return new URL(u, document.baseURI).href } catch (e) { return u }
    }
    // <img> — prefer currentSrc (the candidate the browser actually picked from srcset).
    var imgs = document.getElementsByTagName('img')
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i]
      var src = img.currentSrc || img.src
      if (!src) continue
      push({ kind: 'image', url: abs(src), width: img.naturalWidth || 0, height: img.naturalHeight || 0, alt: img.alt || '' })
    }
    // <source> children: a <picture>/<img> source is an image (srcset), but a
    // <video>/<audio> source is the actual media — classify by the PARENT tag so
    // a <video><source src=…> is not mislabeled as an image (the common case
    // where <video> has no direct src attribute).
    var sources = document.getElementsByTagName('source')
    for (var s = 0; s < sources.length; s++) {
      var so = sources[s]
      var parentTag = so.parentElement ? so.parentElement.tagName.toLowerCase() : ''
      var srcKind = parentTag === 'video' ? 'video' : parentTag === 'audio' ? 'audio' : 'image'
      // srcset is responsive-image syntax (picture/img) → always image candidates.
      var srcset = so.getAttribute('srcset')
      if (srcset) {
        var parts = srcset.split(',')
        for (var p = 0; p < parts.length; p++) {
          var cand = parts[p].trim().split(/\s+/)[0]
          if (cand) push({ kind: 'image', url: abs(cand) })
        }
      }
      var ssrc = so.getAttribute('src')
      if (ssrc) {
        // A <video><source> is a downloadable video too — attach the permalink
        // (resolved from its parent <video>) so it gets a working download button,
        // exactly like a <video> with a direct src.
        var spageUrl = ''
        if (srcKind === 'video') { try { spageUrl = miraNearestPermalink(so.parentElement || so) } catch (e) { spageUrl = '' } }
        push({ kind: srcKind, url: abs(ssrc), mime: so.getAttribute('type') || undefined, pageUrl: spageUrl || undefined })
      }
    }
    // <video> — currentSrc/src, plus a THUMBNAIL. A blob:/MSE src cannot render
    // in the chrome (it is page-scoped), so grab the current frame to a canvas
    // here (where the blob is valid) and hand back a data: URL; fall back to the
    // <video poster> attribute. Frame capture needs a decoded frame (readyState
    // >= 2) and a same-origin (untainted) stream, else it throws — caught.
    var vids = document.getElementsByTagName('video')
    for (var v = 0; v < vids.length; v++) {
      var vid = vids[v]
      var vsrc = vid.currentSrc || vid.src
      var poster = ''
      try {
        if (vid.videoWidth > 0 && vid.readyState >= 2) {
          var cw = Math.min(vid.videoWidth, 320)
          var ch = Math.round(vid.videoHeight * (cw / vid.videoWidth)) || 1
          var cvs = document.createElement('canvas')
          cvs.width = cw
          cvs.height = ch
          cvs.getContext('2d').drawImage(vid, 0, 0, cw, ch)
          poster = cvs.toDataURL('image/jpeg', 0.7)
        }
      } catch (e) {
        poster = ''
      }
      if (!poster && vid.poster) poster = abs(vid.poster)
      // Precise permalink for this specific video, for a yt-dlp download (a blob:
      // src is not downloadable; the permalink is what yt-dlp can extract).
      var pageUrl = ''
      try { pageUrl = miraNearestPermalink(vid) } catch (e) { pageUrl = '' }
      if (vsrc) {
        push({ kind: 'video', url: abs(vsrc), width: vid.videoWidth || 0, height: vid.videoHeight || 0, poster: poster || undefined, pageUrl: pageUrl || undefined })
      } else if (pageUrl) {
        // The <video> has no direct src yet (e.g. X attaches the blob only on
        // play) but we DO have its permalink — emit a url-less video item so it
        // still gets a working yt-dlp download button. Deduped by pageUrl below.
        push({ kind: 'video', url: '', width: vid.videoWidth || 0, height: vid.videoHeight || 0, poster: poster || undefined, pageUrl: pageUrl })
      }
      if (vid.poster) push({ kind: 'image', url: abs(vid.poster), alt: 'poster' })
    }
    // <audio>.
    var auds = document.getElementsByTagName('audio')
    for (var a = 0; a < auds.length; a++) {
      var aud = auds[a]
      var asrc = aud.currentSrc || aud.src
      if (asrc) push({ kind: 'audio', url: abs(asrc) })
    }
    // Inline <svg> — serialize to a data: URL so it can be shown and downloaded.
    var svgs = document.getElementsByTagName('svg')
    for (var g = 0; g < svgs.length && g < 200; g++) {
      try {
        var xml = new XMLSerializer().serializeToString(svgs[g])
        var data = 'data:image/svg+xml;utf8,' + encodeURIComponent(xml)
        var box = svgs[g].getBoundingClientRect()
        push({ kind: 'svg', url: data, width: Math.round(box.width), height: Math.round(box.height) })
      } catch (e) {}
    }
    // CSS background-image urls — bounded element scan (getComputedStyle is costly).
    var all = document.querySelectorAll('*')
    var limit = Math.min(all.length, MAX_ELEMENTS)
    var urlRe = /url\((['"]?)([^'")]+)\1\)/g
    for (var e = 0; e < limit; e++) {
      var bg = ''
      try { bg = getComputedStyle(all[e]).backgroundImage } catch (err) { bg = '' }
      if (!bg || bg === 'none') continue
      var mm
      urlRe.lastIndex = 0
      while ((mm = urlRe.exec(bg))) {
        var bu = mm[2]
        if (bu && bu.indexOf('data:') !== 0) push({ kind: 'image', url: abs(bu), alt: 'background' })
        else if (bu && bu.indexOf('data:image') === 0) push({ kind: 'image', url: bu, alt: 'background' })
      }
    }
    // <canvas> — export to PNG; a cross-origin taint throws, recorded as tainted.
    var canvases = document.getElementsByTagName('canvas')
    for (var c = 0; c < canvases.length && c < 100; c++) {
      var cv = canvases[c]
      try {
        var durl = cv.toDataURL('image/png')
        push({ kind: 'canvas', url: durl, width: cv.width, height: cv.height })
      } catch (err) {
        push({ kind: 'canvas', url: '', width: cv.width, height: cv.height, tainted: true })
      }
    }
    return JSON.stringify(out)
  } catch (e) {
    return '[]'
  }
})();
`;
function nearestVideoPermalinkSource(x, y) {
  return `(function () {
    ${PERMALINK_FN}
    try {
      var el = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
      if (!el) return (typeof location !== 'undefined' && location.href) || '';
      return miraNearestPermalink(el) || location.href;
    } catch (e) { return (typeof location !== 'undefined' && location.href) || ''; }
  })();`;
}
const KINDS = /* @__PURE__ */ new Set([
  "image",
  "video",
  "audio",
  "svg",
  "canvas",
  "font",
  "other"
]);
function parseDomMedia(raw) {
  let arr;
  if (typeof raw === "string") {
    try {
      arr = JSON.parse(raw);
    } catch {
      return [];
    }
  } else {
    arr = raw;
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const entry of arr) {
    if (!entry || typeof entry !== "object") continue;
    const url2 = typeof entry.url === "string" ? entry.url : "";
    const pageUrl = typeof entry.pageUrl === "string" ? entry.pageUrl : "";
    if (!url2 && !entry.tainted && !pageUrl) continue;
    const hasMime = typeof entry.mime === "string" && entry.mime !== "";
    const kind = hasMime ? classifyMedia({ mime: entry.mime, url: url2 }) : typeof entry.kind === "string" && KINDS.has(entry.kind) ? entry.kind : classifyMedia({ url: url2 });
    const item = { url: url2, kind, sources: ["dom"] };
    if (typeof entry.mime === "string" && entry.mime) item.mime = entry.mime;
    if (typeof entry.width === "number" && entry.width > 0) item.width = entry.width;
    if (typeof entry.height === "number" && entry.height > 0) item.height = entry.height;
    if (typeof entry.alt === "string" && entry.alt) item.alt = entry.alt;
    if (typeof entry.poster === "string" && entry.poster) item.poster = entry.poster;
    if (typeof entry.pageUrl === "string" && entry.pageUrl) item.pageUrl = entry.pageUrl;
    if (entry.tainted) item.tainted = true;
    out.push(item);
  }
  return out;
}
function extraBinDirs(home) {
  const dirs = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin"];
  if (home) dirs.push(`${home}/.pyenv/shims`, `${home}/.local/bin`, `${home}/.cargo/bin`);
  return dirs;
}
function augmentedPath(inherited, home) {
  const seen = /* @__PURE__ */ new Set();
  const parts = [];
  for (const dir of [...extraBinDirs(home), ...(inherited ?? "").split(":")]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    parts.push(dir);
  }
  return parts.join(":");
}
function ytdlpArgs(url2, outputDir) {
  return [
    "-o",
    `${outputDir}/%(title).100s.%(ext)s`,
    "--restrict-filenames",
    "--no-playlist",
    "--no-warnings",
    "--newline",
    "--print",
    "after_move:filepath",
    url2
  ];
}
function parseProgress(line) {
  const m = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(line);
  if (!m) return null;
  const p = Number(m[1]);
  return Number.isFinite(p) ? Math.min(100, p) : null;
}
function pickFilepath(stdout) {
  let file = "";
  for (const raw of stdout.split("\n")) {
    const t = raw.trim();
    if (t && !t.startsWith("[")) file = t;
  }
  return file;
}
async function ytdlpDownload(url2, outputDir, env, onProgress) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const child = node_child_process.spawn("yt-dlp", ytdlpArgs(url2, outputDir), {
      env: { ...env, PATH: augmentedPath(env.PATH, env.HOME) }
    });
    let stdout = "";
    const errTail = [];
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      for (const line of String(d).split("\n")) {
        if (!line.trim()) continue;
        parseProgress(line);
        errTail.push(line.trim());
        if (errTail.length > 8) errTail.shift();
      }
    });
    child.on("error", (e) => {
      done({
        saved: false,
        error: e.code === "ENOENT" ? "yt-dlp is not installed (brew install yt-dlp / pip install yt-dlp)" : `yt-dlp failed to start: ${e.message}`
      });
    });
    child.on("close", (code) => {
      if (code === 0) {
        const file = pickFilepath(stdout);
        done({ saved: true, file: file ? file.split("/").pop() ?? file : void 0 });
      } else {
        done({
          saved: false,
          error: errTail.slice(-3).join(" ").trim() || `yt-dlp exited with code ${code}`
        });
      }
    });
  });
}
function isActive(record) {
  return record.state === "progressing";
}
function numberedFilename(filename, n) {
  if (n <= 0) return filename;
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return `${filename} (${n})`;
  return `${filename.slice(0, dot)} (${n})${filename.slice(dot)}`;
}
function completionMessage(record) {
  if (record.state === "completed") return `Downloaded ${record.filename}`;
  if (record.state === "cancelled") return `Cancelled ${record.filename}`;
  return `Download failed: ${record.filename}`;
}
class DownloadTracker {
  records = /* @__PURE__ */ new Map();
  add(record) {
    this.records.set(record.id, record);
  }
  get(id) {
    return this.records.get(id);
  }
  /** Merge a patch into a record and stamp updatedAt; returns undefined (no-op)
   * for an unknown id. The id is never patched. */
  update(id, patch, at) {
    const current = this.records.get(id);
    if (!current) return void 0;
    const next = { ...current, ...patch, id, updatedAt: at };
    this.records.set(id, next);
    return next;
  }
  /** All downloads, newest first. */
  list() {
    return [...this.records.values()].sort((a, b) => b.startedAt - a.startedAt);
  }
  remove(id) {
    return this.records.delete(id);
  }
  /** Drop every finished download (keep the running ones); returns how many were
   * removed. Powers the "Clear" action. */
  clearInactive() {
    let removed = 0;
    for (const [id, record] of this.records) {
      if (!isActive(record)) {
        this.records.delete(id);
        removed++;
      }
    }
    return removed;
  }
  /** Status-bar summary of the running downloads. */
  stats() {
    const active = [...this.records.values()].filter(isActive);
    const since = active.length ? Math.min(...active.map((r) => r.startedAt)) : null;
    let receivedBytes = 0;
    let totalBytes = 0;
    for (const r of active) {
      receivedBytes += r.receivedBytes;
      totalBytes += r.totalBytes;
    }
    return { active: active.length, since, receivedBytes, totalBytes };
  }
}
const DEFAULT_ACCENT = "#6988e6";
const DEFAULT = { background: "#1b1b1f", text: "#ebebeb", accent: DEFAULT_ACCENT };
function docThemeVars(theme) {
  const t = theme ?? DEFAULT;
  const surface = t.background;
  const text = t.text;
  const accent = t.accent ?? DEFAULT_ACCENT;
  const mix = (pct, base = surface) => `color-mix(in srgb, ${text} ${pct}%, ${base})`;
  return [
    `--surface: ${surface};`,
    `--surface-raised: ${mix(4)};`,
    `--surface-mute: ${mix(8)};`,
    `--text: ${text};`,
    `--text-muted: ${mix(58)};`,
    `--text-faint: ${mix(38)};`,
    `--border: ${mix(18)};`,
    `--border-subtle: ${mix(12)};`,
    `--accent: ${accent};`,
    `--accent-strong: color-mix(in srgb, ${accent} 78%, ${text});`,
    `--accent-soft: color-mix(in srgb, ${accent} 16%, transparent);`,
    `--accent-line: color-mix(in srgb, ${accent} 40%, transparent);`
  ].join("\n    ");
}
const HOME_MARKER = "mira-home-page";
function isMiraHomeUrl(url2) {
  return url2 === "" || url2 === "about:blank" || url2.includes(HOME_MARKER);
}
function escapeHtml$3(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function buildHomePage(stats) {
  const profile = escapeHtml$3(stats.profileLabel);
  const loadedNote = stats.loadedCount < stats.tabCount ? `${stats.loadedCount} loaded` : "all loaded";
  const procNote = `${stats.processCount} process${stats.processCount === 1 ? "" : "es"}`;
  return `<!doctype html>
<html lang="en">
<!--${HOME_MARKER}-->
<head><meta charset="utf-8"><title>Mira</title><style>
  :root {
    ${docThemeVars(stats.theme)}
    --bg: var(--surface);
    --card: var(--surface-raised);
    --line: var(--border-subtle);
    --t1: var(--text);
    --t2: var(--text-muted);
    --t3: var(--text-faint);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background:
      radial-gradient(1200px 600px at 50% -10%, color-mix(in srgb, var(--accent) 14%, transparent), transparent 60%),
      radial-gradient(900px 500px at 90% 110%, color-mix(in srgb, var(--accent) 9%, transparent), transparent 55%),
      var(--bg);
    color: var(--t1);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
    display: flex;
    align-items: center;
    justify-content: center;
    user-select: none;
    cursor: default;
    overflow: hidden;
  }
  .wrap { width: min(920px, 92vw); text-align: center; }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 6px;
  }
  .star {
    width: 34px; height: 34px;
    color: var(--accent);
    filter: drop-shadow(0 0 14px var(--accent-soft));
    animation: twinkle 4s ease-in-out infinite;
  }
  @keyframes twinkle {
    0%, 100% { opacity: 0.85; transform: rotate(0deg) scale(1); }
    50%      { opacity: 1;    transform: rotate(0deg) scale(1.08); }
  }
  h1 {
    font-size: 44px;
    font-weight: 600;
    letter-spacing: -0.02em;
    margin: 0;
    background: linear-gradient(180deg, var(--text), var(--accent));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  .greeting { color: var(--t2); font-size: 16px; margin: 2px 0 34px; }
  .greeting b { color: var(--t1); font-weight: 600; }
  .clock { font-variant-numeric: tabular-nums; }
  .cards {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 14px;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 20px 16px;
    text-align: left;
    transition: border-color 0.2s ease, transform 0.2s ease;
  }
  .card:hover { border-color: var(--border); transform: translateY(-2px); }
  .card .label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--t3);
    margin-bottom: 10px;
  }
  .card .value {
    font-size: 26px;
    font-weight: 600;
    letter-spacing: -0.01em;
    line-height: 1.15;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }
  .card .sub { font-size: 12px; color: var(--t2); margin-top: 4px; }
  .foot { margin-top: 26px; color: var(--t3); font-size: 12px; letter-spacing: 0.02em; }
  /* Keyboard-shortcut reference: the "new user, what can I press?" panel. Static
   * (baked at build time), grouped by task, four columns collapsing to two/one. */
  .shortcuts {
    margin-top: 40px;
    text-align: left;
    border-top: 1px solid var(--line);
    padding-top: 26px;
  }
  .shortcuts h2 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.09em;
    color: var(--t3);
    font-weight: 600;
    margin: 0 0 20px;
    text-align: center;
  }
  .sc-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px 28px;
  }
  .sc-col h3 {
    font-size: 12px;
    font-weight: 600;
    color: var(--accent);
    margin: 0 0 8px;
  }
  .sc-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    padding: 3px 0;
  }
  .sc-row .desc { color: var(--t2); font-size: 12.5px; }
  kbd {
    display: inline-block;
    font: 600 11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--t1);
    background: var(--surface-mute);
    border: 1px solid var(--line);
    border-bottom-color: var(--border);
    border-radius: 6px;
    padding: 2px 6px;
    white-space: nowrap;
    box-shadow: 0 1px 0 rgba(0, 0, 0, 0.35);
  }
  @media (max-width: 780px) { .sc-grid { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 520px) {
    .cards { grid-template-columns: 1fr; }
    .sc-grid { grid-template-columns: 1fr; }
  }
  /* Animated starfield behind the chrome: a slow parallax drift of twinkling
   * points, drawn on a full-window canvas. Purely ambient; sits under .wrap. */
  #stars {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: 0;
    pointer-events: none;
  }
  .wrap { position: relative; z-index: 1; }
</style></head>
<body>
  <canvas id="stars" aria-hidden="true"></canvas>
  <div class="wrap">
    <div class="brand">
      <svg class="star" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 1.5c.4 4.9 2.1 6.6 7 7-4.9.4-6.6 2.1-7 7-.4-4.9-2.1-6.6-7-7 4.9-.4 6.6-2.1 7-7z"/>
      </svg>
      <h1>Mira</h1>
    </div>
    <div class="greeting"><span id="hello">Welcome back</span> · <span class="clock" id="clock">--:--</span></div>
    <div class="cards">
      <div class="card">
        <div class="label">Profile</div>
        <div class="value" title="${profile}">${profile}</div>
        <div class="sub">this window</div>
      </div>
      <div class="card">
        <div class="label">Open tabs</div>
        <div class="value">${stats.tabCount}</div>
        <div class="sub">${escapeHtml$3(loadedNote)}</div>
      </div>
      <div class="card">
        <div class="label">Memory</div>
        <div class="value">${escapeHtml$3(stats.memoryText)}</div>
        <div class="sub">${escapeHtml$3(procNote)}</div>
      </div>
    </div>
    <div class="shortcuts">
      <h2>Keyboard shortcuts</h2>
      <div class="sc-grid">
        <div class="sc-col">
          <h3>Tabs</h3>
          <div class="sc-row"><span class="desc">New tab</span><kbd>⌘T</kbd></div>
          <div class="sc-row"><span class="desc">Close tab</span><kbd>⌘W</kbd></div>
          <div class="sc-row"><span class="desc">Reopen closed</span><kbd>⌘⇧T</kbd></div>
          <div class="sc-row"><span class="desc">Duplicate tab</span><kbd>⌘⇧D</kbd></div>
          <div class="sc-row"><span class="desc">Prev / next</span><kbd>⌘↑ ↓</kbd></div>
          <div class="sc-row"><span class="desc">Sleep tab (free RAM)</span><kbd>⌘S</kbd></div>
          <div class="sc-row"><span class="desc">Wake all tabs</span><kbd>⌘⇧R</kbd></div>
        </div>
        <div class="sc-col">
          <h3>Navigate</h3>
          <div class="sc-row"><span class="desc">Command palette</span><kbd>⌘K</kbd></div>
          <div class="sc-row"><span class="desc">Back / forward</span><kbd>⌘← →</kbd></div>
          <div class="sc-row"><span class="desc">Reload</span><kbd>⌘R</kbd></div>
          <div class="sc-row"><span class="desc">Find in page</span><kbd>⌘F</kbd></div>
          <div class="sc-row"><span class="desc">Find next / prev</span><kbd>⌘G</kbd></div>
          <div class="sc-row"><span class="desc">Add to favorites</span><kbd>⌘D</kbd></div>
          <div class="sc-row"><span class="desc">Zoom in / out / reset</span><kbd>⌘= − 0</kbd></div>
        </div>
        <div class="sc-col">
          <h3>Layout</h3>
          <div class="sc-row"><span class="desc">Tab sidebar</span><kbd>⌘B</kbd></div>
          <div class="sc-row"><span class="desc">AI panel</span><kbd>⌘J</kbd></div>
          <div class="sc-row"><span class="desc">Zen mode</span><kbd>⌘⇧H</kbd></div>
          <div class="sc-row"><span class="desc">Settings</span><kbd>⌘,</kbd></div>
          <div class="sc-row"><span class="desc">Developer tools</span><kbd>⌥⌘I</kbd></div>
          <div class="sc-row"><span class="desc">Fullscreen</span><kbd>⌃⌘F</kbd></div>
          <div class="sc-row"><span class="desc">Close window</span><kbd>⌘⇧W</kbd></div>
        </div>
        <div class="sc-col">
          <h3>System-wide</h3>
          <div class="sc-row"><span class="desc">Focus Mira</span><kbd>⌘⇧M</kbd></div>
          <div class="sc-row"><span class="desc">Media gallery</span><kbd>⌘⌥⇧M</kbd></div>
          <h3 style="margin-top:16px">Getting started</h3>
          <div class="sc-row"><span class="desc">Type a URL or search in the bar above</span></div>
          <div class="sc-row"><span class="desc">Press ⌘K for any command</span></div>
          <div class="sc-row"><span class="desc">Switch profiles from the menu bar</span></div>
        </div>
      </div>
    </div>
    <div class="foot">Type an address above, or press ⌘K to search</div>
  </div>
  <script>
    (function () {
      var hello = document.getElementById('hello');
      var clock = document.getElementById('clock');
      function tick() {
        var d = new Date();
        var h = d.getHours();
        hello.textContent = h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
        var hh = String(h).padStart(2, '0');
        var mm = String(d.getMinutes()).padStart(2, '0');
        clock.textContent = hh + ':' + mm;
      }
      tick();
      setInterval(tick, 15000);
    })();
  <\/script>
  <script>
    (function () {
      var canvas = document.getElementById('stars');
      if (!canvas || !canvas.getContext) return;
      var ctx = canvas.getContext('2d');
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var stars = [];
      var W = 0, H = 0;

      function seed() {
        // Density scales with area so big and small windows feel alike.
        var count = Math.round((W * H) / 9000);
        stars = [];
        for (var i = 0; i < count; i++) {
          stars.push({
            x: Math.random() * W,
            y: Math.random() * H,
            r: Math.random() * 1.3 + 0.3,       // radius
            drift: Math.random() * 0.08 + 0.02,  // upward px/frame (parallax by size)
            phase: Math.random() * Math.PI * 2,  // twinkle offset
            speed: Math.random() * 0.02 + 0.008  // twinkle rate
          });
        }
      }

      function resize() {
        W = window.innerWidth;
        H = window.innerHeight;
        canvas.width = W * dpr;
        canvas.height = H * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        seed();
      }

      var t = 0;
      function frame() {
        t += 1;
        ctx.clearRect(0, 0, W, H);
        for (var i = 0; i < stars.length; i++) {
          var s = stars[i];
          // Drift upward, wrapping back to the bottom — a slow parallax rise.
          s.y -= s.drift;
          if (s.y < -2) { s.y = H + 2; s.x = Math.random() * W; }
          var a = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(s.phase + t * s.speed));
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(180, 195, 255, ' + a.toFixed(3) + ')';
          ctx.fill();
        }
        requestAnimationFrame(frame);
      }

      window.addEventListener('resize', resize);
      resize();
      requestAnimationFrame(frame);
    })();
  <\/script>
</body>
</html>`;
}
function homePageUrl(stats) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(buildHomePage(stats))}`;
}
const ERROR_MARKER = "mira-error-page";
function isMiraErrorUrl(url2) {
  return url2.includes(ERROR_MARKER);
}
function describeLoadError(err) {
  switch (err.errorCode) {
    case -105:
      return {
        headline: "This site can't be reached",
        hint: `The server address could not be found. Check the URL for typos — the domain may not exist.`
      };
    case -106:
      return {
        headline: "No internet connection",
        hint: "Your computer appears to be offline. Check your network and try again."
      };
    case -102:
      return {
        headline: "Connection refused",
        hint: "The server is reachable but refused the connection. It may be down or not listening on this port."
      };
    case -101:
      return {
        headline: "Connection reset",
        hint: "The connection was interrupted by the server or something in between. Retrying often works."
      };
    case -7:
    // ERR_TIMED_OUT
    case -118:
      return {
        headline: "Connection timed out",
        hint: "The server took too long to respond. It may be overloaded, or blocked by a firewall."
      };
    case -109:
      return {
        headline: "Address unreachable",
        hint: "No route to the server. Check your network, VPN, or proxy configuration."
      };
    default:
      if (err.errorCode <= -200 && err.errorCode > -300) {
        return {
          headline: "Connection is not secure",
          hint: "The site presented an invalid security certificate, so Mira did not load it."
        };
      }
      return {
        headline: "This page failed to load",
        hint: "Something went wrong while loading the page. Retrying may fix it."
      };
  }
}
function escapeHtml$2(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function buildErrorPage(err) {
  const { headline, hint } = describeLoadError(err);
  const target = JSON.stringify(err.url).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<!--${ERROR_MARKER}-->
<head><meta charset="utf-8"><title>${escapeHtml$2(headline)}</title><style>
  :root {
    ${docThemeVars(err.theme)}
    --bg: var(--surface);
    --card: var(--surface-raised);
    --line: var(--border-subtle);
    --t1: var(--text);
    --t2: var(--text-muted);
    --t3: var(--text-faint);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background:
      radial-gradient(1200px 600px at 50% -10%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 60%),
      var(--bg);
    color: var(--t1);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
    display: flex;
    align-items: center;
    justify-content: center;
    user-select: none;
    cursor: default;
    overflow: hidden;
  }
  .wrap { width: min(560px, 86vw); }
  .badge {
    width: 44px; height: 44px;
    border-radius: 12px;
    background: var(--card);
    border: 1px solid var(--line);
    display: flex; align-items: center; justify-content: center;
    color: var(--accent);
    margin-bottom: 18px;
  }
  h1 { font-size: 26px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 8px; }
  .hint { color: var(--t2); margin: 0 0 22px; }
  .detail {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 14px 16px;
    margin-bottom: 22px;
    font-size: 13px;
  }
  .detail .url {
    color: var(--t1);
    word-break: break-all;
    user-select: text;
    cursor: text;
  }
  .detail .code {
    color: var(--t3);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    margin-top: 6px;
  }
  button {
    font: inherit;
    color: var(--bg);
    background: var(--accent);
    border: none;
    border-radius: 10px;
    padding: 9px 22px;
    font-weight: 600;
    cursor: pointer;
  }
  button:hover { filter: brightness(1.1); }
</style></head>
<body>
  <div class="wrap">
    <div class="badge">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <circle cx="12" cy="12" r="9"></circle>
        <line x1="12" y1="8" x2="12" y2="13"></line>
        <line x1="12" y1="16" x2="12" y2="16"></line>
      </svg>
    </div>
    <h1>${escapeHtml$2(headline)}</h1>
    <p class="hint">${escapeHtml$2(hint)}</p>
    <div class="detail">
      <div class="url">${escapeHtml$2(err.url)}</div>
      <div class="code">${escapeHtml$2(err.errorDescription)} (${err.errorCode})</div>
    </div>
    <button id="retry" autofocus>Retry</button>
  </div>
  <script>
    document.getElementById('retry').addEventListener('click', function () {
      location.href = ${target};
    });
  <\/script>
</body>
</html>`;
}
function errorPageUrl(err) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(buildErrorPage(err))}`;
}
class LlmRunner {
  deps;
  constructor(deps) {
    this.deps = {
      runClaudeCli: spawnClaudeCli,
      runClaudeCliStream: spawnClaudeCliStream,
      fetchFn: (...args) => fetch(...args),
      ...deps
    };
  }
  /** One-shot summary (a skill prompt + the page text). 'extractive' has no model,
   * so it returns a lead-sentence summary of the text; 'anthropic-api' hits the
   * Messages API; 'claude-cli' feeds the composed prompt to `claude -p` on stdin. */
  async run(config, prompt, text) {
    if (config.provider === "extractive") return extractiveSummary(text);
    if (config.provider === "anthropic-api") {
      const req = buildAnthropicRequest(config, prompt, text);
      const res = await this.deps.fetchFn(req.url, {
        method: "POST",
        headers: req.headers,
        body: JSON.stringify(req.body)
      });
      return parseAnthropicResponse(await res.json());
    }
    return this.deps.runClaudeCli(config, composePrompt(prompt, text));
  }
  /** The chat engine (run-prompt): answer the last turn given the whole thread and
   * the page's text as context. Same three providers as run(), but multi-turn.
   * 'extractive' has no conversational model, so it falls back to a lead-sentence
   * summary of the page (ignoring the question), or echoes the last question when
   * there is no page. A turn WITH a screenshot goes through the CLI stream-json
   * path (which accepts an image block); a text-only turn stays on the plain path. */
  async chat(config, messages, page) {
    const system = chatSystemPrompt(page.url, page.text);
    if (config.provider === "extractive") {
      const last = messages[messages.length - 1]?.text ?? "";
      return extractiveSummary(page.text.trim() !== "" ? page.text : last);
    }
    if (config.provider === "anthropic-api") {
      const req = buildAnthropicChatRequest(config, system, messages, page.screenshot);
      const res = await this.deps.fetchFn(req.url, {
        method: "POST",
        headers: req.headers,
        body: JSON.stringify(req.body)
      });
      return parseAnthropicResponse(await res.json());
    }
    if (page.screenshot) {
      return this.deps.runClaudeCliStream(
        config,
        buildClaudeStreamInput(system, messages, page.screenshot)
      );
    }
    return this.deps.runClaudeCli(config, composeChatPrompt(system, messages));
  }
}
function spawnClaudeCli(config, fullPrompt) {
  return new Promise((resolve, reject) => {
    const child = child_process.spawn("claude", buildClaudeCliArgs(config), {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => out += String(d));
    child.stderr.on("data", (d) => err += String(d));
    child.on(
      "error",
      (e) => reject(new Error(`claude CLI not runnable: ${e.message} (is it installed / on PATH?)`))
    );
    child.on("close", (code) => {
      if (code === 0) {
        const text = out.trim();
        if (text === "") reject(new Error("claude CLI returned no output"));
        else resolve(text);
      } else {
        reject(new Error(err.trim() || `claude CLI exited with code ${code}`));
      }
    });
    child.stdin.write(fullPrompt);
    child.stdin.end();
  });
}
function spawnClaudeCliStream(config, streamInput) {
  return new Promise((resolve, reject) => {
    const child = child_process.spawn("claude", buildClaudeStreamArgs(config), {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => out += String(d));
    child.stderr.on("data", (d) => err += String(d));
    child.on(
      "error",
      (e) => reject(new Error(`claude CLI not runnable: ${e.message} (is it installed / on PATH?)`))
    );
    child.on("close", (code) => {
      if (code !== 0 && err.trim() !== "") {
        reject(new Error(err.trim()));
        return;
      }
      try {
        resolve(parseClaudeStreamResult(out));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    child.stdin.write(streamInput);
    child.stdin.end();
  });
}
function findNode(tree, id) {
  for (const node of tree) {
    if (node.id === id) return node;
    if (node.kind === "folder") {
      const found = findNode(node.children, id);
      if (found) return found;
    }
  }
  return void 0;
}
function findUrl(tree, url2) {
  for (const node of tree) {
    if (node.kind === "url") {
      if (node.url === url2) return node;
    } else {
      const found = findUrl(node.children, url2);
      if (found) return found;
    }
  }
  return void 0;
}
function isSelfOrDescendant(tree, id, folderId) {
  if (id === folderId) return true;
  const node = findNode(tree, id);
  if (!node || node.kind !== "folder") return false;
  return findNode(node.children, folderId) !== void 0;
}
function insertNode(tree, parentId, node, index) {
  if (parentId === null) {
    return spliceInto(tree, node, index);
  }
  const parent = findNode(tree, parentId);
  if (!parent) throw new Error(`unknown folder: ${parentId}`);
  if (parent.kind !== "folder") throw new Error(`not a folder: ${parentId}`);
  return tree.map((n) => mapInsert(n, parentId, node, index));
}
function mapInsert(n, parentId, node, index) {
  if (n.kind !== "folder") return n;
  if (n.id === parentId) return { ...n, children: spliceInto(n.children, node, index) };
  return { ...n, children: n.children.map((c) => mapInsert(c, parentId, node, index)) };
}
function spliceInto(list, node, index) {
  const at = index === void 0 ? list.length : Math.min(Math.max(index, 0), list.length);
  const out = [...list];
  out.splice(at, 0, node);
  return out;
}
function removeNode(tree, id) {
  return tree.filter((n) => n.id !== id).map((n) => n.kind === "folder" ? { ...n, children: removeNode(n.children, id) } : n);
}
function renameNode(tree, id, title) {
  if (!findNode(tree, id)) throw new Error(`unknown bookmark: ${id}`);
  const rename = (n) => {
    if (n.id === id) return { ...n, title };
    if (n.kind === "folder") return { ...n, children: n.children.map(rename) };
    return n;
  };
  return tree.map(rename);
}
function moveNode(tree, id, newParentId, index) {
  const node = findNode(tree, id);
  if (!node) throw new Error(`unknown bookmark: ${id}`);
  if (newParentId !== null && isSelfOrDescendant(tree, id, newParentId)) {
    throw new Error("cannot move a folder into itself");
  }
  const detached = removeNode(tree, id);
  return insertNode(detached, newParentId, node, index);
}
function normalizeBookmarks(raw) {
  return normalizeList(raw, /* @__PURE__ */ new Set());
}
function normalizeList(raw, seen) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const node = normalizeNode(item, seen);
    if (node) out.push(node);
  }
  return out;
}
function normalizeNode(raw, seen) {
  if (!raw || typeof raw !== "object") return null;
  const v = raw;
  if (typeof v.id !== "string" || v.id.trim() === "") return null;
  if (seen.has(v.id)) return null;
  const title = typeof v.title === "string" ? v.title : "";
  if (v.kind === "folder" || Array.isArray(v.children)) {
    seen.add(v.id);
    return { id: v.id, kind: "folder", title, children: normalizeList(v.children, seen) };
  }
  if (typeof v.url !== "string" || v.url.trim() === "") return null;
  seen.add(v.id);
  return { id: v.id, kind: "url", title, url: v.url };
}
class BookmarksController {
  constructor(deps) {
    this.deps = deps;
    this.tree = deps.initial;
  }
  deps;
  tree;
  /** The current favorites tree (for the native menu and the listBookmarks command). */
  get() {
    return this.tree;
  }
  /** Add a url favorite under `parentId` (a folder id, or undefined = top level).
   * Idempotent by url — an already-saved page (anywhere in the tree) returns the
   * existing node with created:false and no write. Throws when parentId is unknown
   * or not a folder (insertNode validates before we persist). */
  addUrl(url2, title, parentId) {
    const existing = findUrl(this.tree, url2);
    if (existing) return { node: existing, created: false };
    const node = { id: crypto.randomUUID(), kind: "url", title, url: url2 };
    this.tree = insertNode(this.tree, parentId ?? null, node);
    this.commit();
    return { node, created: true };
  }
  /** Add an empty folder under `parentId` (or top level). */
  addFolder(title, parentId) {
    const node = { id: crypto.randomUUID(), kind: "folder", title, children: [] };
    this.tree = insertNode(this.tree, parentId ?? null, node);
    this.commit();
    return { node };
  }
  /** Remove a node (url or folder) by id. Commits only when it existed. */
  remove(id) {
    const removed = findNode(this.tree, id) !== void 0;
    if (removed) {
      this.tree = removeNode(this.tree, id);
      this.commit();
    }
    return { removed };
  }
  /** Relabel a node. Throws (via renameNode) on an unknown id. */
  rename(id, title) {
    this.tree = renameNode(this.tree, id, title);
    this.commit();
    return { node: findNode(this.tree, id) };
  }
  /** Reparent / reorder a node. Throws (via moveNode) on invalid moves. */
  move(id, parentId, index) {
    this.tree = moveNode(this.tree, id, parentId, index);
    this.commit();
    return { moved: true };
  }
  /** The url of a url-favorite by id, for opening it in a tab. Throws on an unknown
   * id or a folder id (the manager turns this into a new tab). */
  urlFor(id) {
    const node = findNode(this.tree, id);
    if (!node) throw new Error(`unknown bookmark: ${id}`);
    if (node.kind !== "url") throw new Error(`not a url bookmark: ${id}`);
    return node.url;
  }
  /** Persist the tree and notify the manager (broadcast + native menu rebuild).
   * Bookmarks are global, so one change refreshes them all. */
  commit() {
    this.deps.persist(this.tree);
    this.deps.onChange(this.tree);
  }
}
const DEFAULT_THEME_ID = "midnight";
const BUILTIN_THEMES = [
  { id: "midnight", name: "Midnight", background: "#1b1b1f", text: "#ebebeb", accent: "#6988e6", builtin: true },
  { id: "slate", name: "Slate", background: "#24272e", text: "#e6e8ec", accent: "#8aa0c8", builtin: true },
  {
    id: "paper",
    name: "Paper",
    background: "#ffffff",
    text: "#1a1a1a",
    accent: "#3b6fe0",
    // A subtle paper texture behind the chrome (Wikimedia Commons, CC BY 2.0).
    wallpaper: "https://upload.wikimedia.org/wikipedia/commons/8/82/Vintage_Paper_Texture_%289789792113%29.jpg",
    builtin: true
  },
  { id: "sepia", name: "Sepia", background: "#f4ecd8", text: "#433422", accent: "#a9743b", builtin: true }
];
const BUILTIN_IDS = new Set(BUILTIN_THEMES.map((t) => t.id));
function isHexColor(value) {
  return typeof value === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);
}
function isWallpaperUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function nextThemeId(name, taken) {
  const used = new Set(taken);
  const base = slugify(name) || "theme";
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
function isBuiltinTheme(id) {
  return BUILTIN_IDS.has(id);
}
function normalizeThemes(raw) {
  const custom = [];
  const seen = new Set(BUILTIN_IDS);
  const list = Array.isArray(raw) ? raw : [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const { id, name, background, text, accent, wallpaper } = item;
    if (typeof id !== "string" || id.trim() === "") continue;
    if (typeof name !== "string" || name.trim() === "") continue;
    if (!isHexColor(background) || !isHexColor(text)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    custom.push({
      id,
      name: name.trim(),
      background,
      text,
      ...isHexColor(accent) ? { accent } : {},
      ...isWallpaperUrl(wallpaper) ? { wallpaper } : {}
    });
  }
  return [...BUILTIN_THEMES, ...custom];
}
function customThemes(themes) {
  return themes.filter((t) => !isBuiltinTheme(t.id));
}
function findTheme(themes, id) {
  return themes.find((t) => t.id === id);
}
function validateInput(input) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name === "") throw new Error("empty name");
  if (!isHexColor(input.background)) throw new Error(`invalid background: ${input.background}`);
  if (!isHexColor(input.text)) throw new Error(`invalid text: ${input.text}`);
  if (input.accent != null && !isHexColor(input.accent)) {
    throw new Error(`invalid accent: ${input.accent}`);
  }
  if (input.wallpaper != null && input.wallpaper !== "" && !isWallpaperUrl(input.wallpaper)) {
    throw new Error(`invalid wallpaper: ${input.wallpaper}`);
  }
  return {
    name,
    background: input.background,
    text: input.text,
    ...input.accent ? { accent: input.accent } : {},
    ...input.wallpaper ? { wallpaper: input.wallpaper } : {}
  };
}
function createTheme(themes, input) {
  const fields = validateInput(input);
  const id = nextThemeId(fields.name, themes.map((t) => t.id));
  const theme = { id, ...fields };
  return [[...themes, theme], theme];
}
function updateTheme(themes, id, patch) {
  const existing = findTheme(themes, id);
  if (!existing) throw new Error(`unknown theme: ${id}`);
  if (existing.builtin || isBuiltinTheme(id)) throw new Error(`cannot edit built-in theme: ${id}`);
  const merged = validateInput({
    name: patch.name ?? existing.name,
    background: patch.background ?? existing.background,
    text: patch.text ?? existing.text,
    accent: patch.accent === void 0 ? existing.accent : patch.accent,
    wallpaper: patch.wallpaper === void 0 ? existing.wallpaper : patch.wallpaper
  });
  return themes.map((t) => t.id === id ? { id, ...merged } : t);
}
function deleteTheme(themes, id) {
  if (isBuiltinTheme(id)) throw new Error(`cannot delete built-in theme: ${id}`);
  return themes.filter((t) => t.id !== id);
}
function resolveProfileTheme(themeId, legacyColor, themes) {
  if (themeId) {
    const found = findTheme(themes, themeId);
    if (found) return found;
  }
  const base = findTheme(themes, DEFAULT_THEME_ID) ?? BUILTIN_THEMES[0];
  if (!themeId && isHexColor(legacyColor)) {
    return { ...base, id: `legacy:${legacyColor}`, name: "Custom", accent: legacyColor };
  }
  return base;
}
const DEFAULT_CAP_GB = 100;
function runHdiutil(args, password) {
  return new Promise((resolve, reject) => {
    const child = child_process.spawn("/usr/bin/hdiutil", args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => out += String(d));
    child.stderr.on("data", (d) => err += String(d));
    child.on("error", (e) => reject(new Error(`hdiutil not runnable: ${e.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else {
        const msg = err.trim() || `hdiutil exited with code ${code}`;
        const authFailure = /authentication error/i.test(msg);
        reject(new Error(authFailure ? "wrong password" : msg));
      }
    });
    if (password !== void 0) child.stdin.write(password);
    child.stdin.end();
  });
}
async function mount(bundle, password) {
  const out = await runHdiutil(["attach", "-stdinpass", "-nobrowse", bundle], password);
  const idx = out.indexOf("/Volumes/");
  if (idx === -1) throw new Error("mounted, but could not read the mount point");
  return out.slice(idx).split("\n")[0].trim();
}
async function unmount(mountPoint, force = false) {
  await runHdiutil(["detach", ...force ? ["-force"] : [], mountPoint]);
}
function fileInventory(root) {
  const map = /* @__PURE__ */ new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) map.set(path.relative(root, full), fs.statSync(full).size);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return map;
}
function verifyCopy(src, dest) {
  const want = fileInventory(src);
  const have = fileInventory(dest);
  for (const [rel, size] of want) {
    if (have.get(rel) !== size) return false;
  }
  return true;
}
function replaceDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(src)) fs.cpSync(src, dest, { recursive: true });
}
async function encrypt(plan, password) {
  if (fs.existsSync(plan.bundle)) throw new Error(`a vault already exists: ${plan.bundle}`);
  fs.mkdirSync(path.dirname(plan.bundle), { recursive: true });
  await runHdiutil(
    [
      "create",
      "-encryption",
      "AES-256",
      "-stdinpass",
      "-type",
      "SPARSEBUNDLE",
      "-fs",
      "APFS",
      "-volname",
      plan.volumeName,
      "-size",
      `${DEFAULT_CAP_GB}g`,
      plan.bundle
    ],
    password
  );
  let mountPoint = null;
  try {
    mountPoint = await mount(plan.bundle, password);
    for (const dir of plan.dirs) {
      if (fs.existsSync(dir.live)) fs.cpSync(dir.live, path.join(mountPoint, dir.name), { recursive: true });
    }
    for (const dir of plan.dirs) {
      if (fs.existsSync(dir.live) && !verifyCopy(dir.live, path.join(mountPoint, dir.name))) {
        throw new Error(`vault copy of ${dir.name} could not be verified`);
      }
    }
    await unmount(mountPoint);
    mountPoint = null;
    for (const dir of plan.dirs) fs.rmSync(dir.live, { recursive: true, force: true });
  } catch (error) {
    if (mountPoint) await unmount(mountPoint, true).catch(() => {
    });
    fs.rmSync(plan.bundle, { recursive: true, force: true });
    throw error;
  }
}
function discardProfilePlaintext(userDataDir, profileId) {
  fs.rmSync(path.join(userDataDir, "profiles", profileId), { recursive: true, force: true });
  const partitionsRoot = path.join(userDataDir, "Partitions");
  if (!fs.existsSync(partitionsRoot)) return;
  for (const entry of fs.readdirSync(partitionsRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && isProfilePartitionDir(entry.name, profileId)) {
      fs.rmSync(path.join(partitionsRoot, entry.name), { recursive: true, force: true });
    }
  }
}
async function unlock(plan, password) {
  if (!fs.existsSync(plan.bundle)) throw new Error(`no vault: ${plan.bundle}`);
  const mountPoint = await mount(plan.bundle, password);
  try {
    for (const dir of plan.dirs) replaceDir(path.join(mountPoint, dir.name), dir.live);
  } finally {
    await unmount(mountPoint).catch(() => unmount(mountPoint, true));
  }
}
async function lock(plan, password) {
  if (!fs.existsSync(plan.bundle)) throw new Error(`no vault: ${plan.bundle}`);
  const mountPoint = await mount(plan.bundle, password);
  try {
    for (const dir of plan.dirs) {
      const dest = path.join(mountPoint, dir.name);
      fs.rmSync(dest, { recursive: true, force: true });
      if (fs.existsSync(dir.live)) fs.cpSync(dir.live, dest, { recursive: true });
    }
    for (const dir of plan.dirs) {
      if (fs.existsSync(dir.live) && !verifyCopy(dir.live, path.join(mountPoint, dir.name))) {
        throw new Error(`vault copy of ${dir.name} could not be verified`);
      }
    }
  } finally {
    await unmount(mountPoint).catch(() => unmount(mountPoint, true));
  }
  for (const dir of plan.dirs) fs.rmSync(dir.live, { recursive: true, force: true });
}
function emptyTabState() {
  return { tabs: [], activeId: null };
}
function addTab(state, tab) {
  return { tabs: [...state.tabs, tab], activeId: tab.id };
}
function addTabAtHead(state, tab) {
  const boundary = state.tabs.filter((t) => t.pinned === true).length;
  const tabs = [...state.tabs];
  tabs.splice(boundary, 0, tab);
  return { tabs, activeId: tab.id };
}
function addTabInactive(state, tab) {
  return { tabs: [...state.tabs, tab], activeId: state.activeId ?? tab.id };
}
function addTabAfter(state, tab, afterId) {
  const from = state.tabs.findIndex((t) => t.id === afterId);
  if (from === -1) return addTab(state, tab);
  const boundary = state.tabs.filter((t) => t.pinned === true).length;
  const insertAt = Math.max(from + 1, boundary);
  const tabs = [...state.tabs];
  tabs.splice(insertAt, 0, tab);
  return { tabs, activeId: tab.id };
}
function selectTab(state, id) {
  if (!state.tabs.some((t) => t.id === id)) return state;
  return { ...state, activeId: id };
}
function updateTab(state, id, patch) {
  return {
    ...state,
    tabs: state.tabs.map((t) => t.id === id ? { ...t, ...patch } : t)
  };
}
function closeTab(state, id) {
  const index = state.tabs.findIndex((t) => t.id === id);
  if (index === -1) return state;
  const tabs = state.tabs.filter((t) => t.id !== id);
  if (state.activeId !== id) return { tabs, activeId: state.activeId };
  const neighbor = tabs[index] ?? tabs[index - 1] ?? null;
  return { tabs, activeId: neighbor ? neighbor.id : null };
}
function nextLoadedTab(state, loaded) {
  const index = state.tabs.findIndex((t) => t.id === state.activeId);
  if (index === -1) return null;
  for (let i = index + 1; i < state.tabs.length; i++) {
    if (loaded.has(state.tabs[i].id)) return state.tabs[i].id;
  }
  for (let i = index - 1; i >= 0; i--) {
    if (loaded.has(state.tabs[i].id)) return state.tabs[i].id;
  }
  return null;
}
function moveTab(state, id, toIndex) {
  const from = state.tabs.findIndex((t) => t.id === id);
  if (from === -1) return state;
  const tabs = [...state.tabs];
  const [moved] = tabs.splice(from, 1);
  const boundary = tabs.filter((t) => t.pinned === true).length;
  const min = moved.pinned === true ? 0 : boundary;
  const max = moved.pinned === true ? boundary : tabs.length;
  const insertAt = Math.min(Math.max(toIndex, min), max);
  tabs.splice(insertAt, 0, moved);
  return { ...state, tabs };
}
function pinTab(state, id) {
  const from = state.tabs.findIndex((t) => t.id === id);
  if (from === -1 || state.tabs[from].pinned === true) return state;
  const tabs = [...state.tabs];
  const [tab] = tabs.splice(from, 1);
  const insertAt = tabs.filter((t) => t.pinned === true).length;
  tabs.splice(insertAt, 0, { ...tab, pinned: true });
  return { ...state, tabs };
}
function unpinTab(state, id) {
  const from = state.tabs.findIndex((t) => t.id === id);
  if (from === -1 || state.tabs[from].pinned !== true) return state;
  const tabs = [...state.tabs];
  const [tab] = tabs.splice(from, 1);
  const insertAt = tabs.filter((t) => t.pinned === true).length;
  tabs.splice(insertAt, 0, { ...tab, pinned: false });
  return { ...state, tabs };
}
function setKeepAwake(state, id, value) {
  if (!state.tabs.some((t) => t.id === id)) return state;
  return {
    ...state,
    tabs: state.tabs.map((t) => {
      if (t.id !== id) return t;
      if (value) return { ...t, keepAwake: true };
      const { keepAwake: _drop, ...rest } = t;
      return rest;
    })
  };
}
function closeActiveDecision(state, armedId) {
  const active = state.tabs.find((t) => t.id === state.activeId);
  if (!active) return { action: "none" };
  if (active.pinned === true && armedId !== active.id) return { action: "arm", id: active.id };
  return { action: "close", id: active.id };
}
function emptyMru() {
  return { ids: [], cursor: -1 };
}
function mruRecord(mru, id) {
  if (mru.ids[mru.cursor] === id) return mru;
  const ids = mru.ids.slice(0, mru.cursor + 1).filter((x) => x !== id);
  ids.push(id);
  return { ids, cursor: ids.length - 1 };
}
function mruStep(mru, direction) {
  const next = mru.cursor + direction;
  if (next < 0 || next >= mru.ids.length) return { mru, id: null };
  return { mru: { ids: mru.ids, cursor: next }, id: mru.ids[next] };
}
function mruPrune(mru, id) {
  const idx = mru.ids.indexOf(id);
  if (idx === -1) return mru;
  const ids = mru.ids.slice(0, idx).concat(mru.ids.slice(idx + 1));
  if (ids.length === 0) return { ids, cursor: -1 };
  let cursor = mru.cursor;
  if (idx < cursor) cursor -= 1;
  if (cursor > ids.length - 1) cursor = ids.length - 1;
  return { ids, cursor };
}
function addFolder(folders, folder) {
  return [...folders, folder];
}
function renameFolder(folders, id, title) {
  return folders.map((f) => f.id === id ? { ...f, title } : f);
}
function setFolderColor(folders, id, color) {
  return folders.map((f) => {
    if (f.id !== id) return f;
    const next = { ...f };
    if (color === null) delete next.color;
    else next.color = color;
    return next;
  });
}
function setFolderCollapsed(folders, id, collapsed) {
  return folders.map((f) => f.id === id ? { ...f, collapsed: collapsed ?? !f.collapsed } : f);
}
function removeFolder(folders, id) {
  return folders.filter((f) => f.id !== id);
}
function hasFolder(folders, id) {
  return folders.some((f) => f.id === id);
}
function setTabFolder(state, tabId, folderId) {
  const tabs = state.tabs.map((t) => {
    if (t.id !== tabId) return t;
    const next = { ...t };
    if (folderId === null) delete next.folderId;
    else next.folderId = folderId;
    return next;
  });
  return { ...state, tabs };
}
function clearFolderMembership(state, folderId) {
  const tabs = state.tabs.map((t) => {
    if (t.folderId !== folderId) return t;
    const next = { ...t };
    delete next.folderId;
    return next;
  });
  return { ...state, tabs };
}
function pruneFolderMembership(state, folders) {
  const known = new Set(folders.map((f) => f.id));
  let changed = false;
  const tabs = state.tabs.map((t) => {
    if (t.folderId === void 0 || known.has(t.folderId)) return t;
    changed = true;
    const next = { ...t };
    delete next.folderId;
    return next;
  });
  return changed ? { ...state, tabs } : state;
}
function folderTabs(tabs, folderId) {
  return tabs.filter((t) => t.pinned !== true && t.folderId === folderId);
}
function looseTabs(tabs) {
  return tabs.filter((t) => t.pinned !== true && t.folderId === void 0);
}
function navigableTabIds(tabs, folders) {
  const pinned = tabs.filter((t) => t.pinned === true).map((t) => t.id);
  const inExpandedFolders = folders.filter((f) => !f.collapsed).flatMap((f) => folderTabs(tabs, f.id).map((t) => t.id));
  const loose = looseTabs(tabs).map((t) => t.id);
  return [...pinned, ...inExpandedFolders, ...loose];
}
function nextNavigableTabId(tabs, folders, activeId, direction) {
  const order = navigableTabIds(tabs, folders);
  if (order.length === 0) return null;
  const index = activeId === null ? -1 : order.indexOf(activeId);
  if (index === -1) return direction === 1 ? order[0] : order[order.length - 1];
  return order[(index + direction + order.length) % order.length];
}
function normalizeTabFolders(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const value of raw) {
    if (!value || typeof value !== "object") continue;
    const v = value;
    if (typeof v.id !== "string" || v.id === "" || seen.has(v.id)) continue;
    seen.add(v.id);
    out.push({
      id: v.id,
      title: typeof v.title === "string" ? v.title : "",
      collapsed: v.collapsed === true,
      // Keep a color only when it is a non-empty string; a bad value degrades to
      // the default look rather than propagating garbage into the DOM.
      ...typeof v.color === "string" && v.color !== "" ? { color: v.color } : {}
    });
  }
  return out;
}
function toPersisted(state, panelCollapsed, bounds, open, folders = [], loadedIds = /* @__PURE__ */ new Set(), windowId) {
  const found = state.tabs.findIndex((t) => t.id === state.activeId);
  return {
    // A live snapshot always knows its windowId; the fallback keeps the field's
    // type non-optional for the rare caller (tests) that omits it.
    windowId: windowId ?? node_crypto.randomUUID(),
    tabs: state.tabs.map((t) => ({
      url: t.url,
      title: t.title,
      favicon: t.favicon,
      ...t.pinned === true ? { pinned: true } : {},
      ...t.folderId ? { folderId: t.folderId } : {},
      ...loadedIds.has(t.id) ? { loaded: true } : {},
      ...t.keepAwake === true ? { keepAwake: true } : {}
    })),
    activeIndex: found === -1 ? 0 : found,
    panelCollapsed,
    // Only written when non-empty, so a folder-less window stays byte-identical
    // to the old shape (mirrors bounds / pinned / open).
    ...folders.length ? { folders } : {},
    ...bounds ? { bounds } : {},
    ...open !== void 0 ? { open } : {}
  };
}
function normalizeSessions(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [id, value] of Object.entries(raw)) {
    const list = Array.isArray(value) ? value : [value];
    const windows = [];
    for (const v of list) {
      const win = normalizeWindow(v);
      if (win) windows.push(win);
    }
    if (windows.length > 0) out[id] = windows;
  }
  return out;
}
function normalizeWindow(value) {
  if (!value || typeof value !== "object") return null;
  const v = value;
  const windowId = typeof v.windowId === "string" && v.windowId !== "" ? v.windowId : node_crypto.randomUUID();
  const rawTabs = Array.isArray(v.tabs) ? v.tabs : [];
  const tabs = [];
  for (const t of rawTabs) {
    if (!t || typeof t !== "object") continue;
    const tv = t;
    if (typeof tv.url !== "string" || tv.url === "") continue;
    tabs.push({
      url: tv.url,
      title: typeof tv.title === "string" ? tv.title : "",
      favicon: typeof tv.favicon === "string" ? tv.favicon : null,
      ...tv.pinned === true ? { pinned: true } : {},
      ...typeof tv.folderId === "string" && tv.folderId !== "" ? { folderId: tv.folderId } : {},
      ...tv.loaded === true ? { loaded: true } : {},
      ...tv.keepAwake === true ? { keepAwake: true } : {}
    });
  }
  if (tabs.length === 0) return null;
  const rawIndex = typeof v.activeIndex === "number" ? Math.floor(v.activeIndex) : 0;
  const bounds = normalizeBounds(v.bounds);
  const folders = normalizeTabFolders(v.folders);
  const knownFolders = new Set(folders.map((f) => f.id));
  for (const t of tabs) {
    if (t.folderId !== void 0 && !knownFolders.has(t.folderId)) delete t.folderId;
  }
  return {
    windowId,
    tabs,
    activeIndex: Math.min(Math.max(rawIndex, 0), tabs.length - 1),
    panelCollapsed: v.panelCollapsed === true,
    ...folders.length ? { folders } : {},
    ...bounds ? { bounds } : {},
    ...typeof v.open === "boolean" ? { open: v.open } : {}
  };
}
function normalizeBounds(raw) {
  if (!raw || typeof raw !== "object") return void 0;
  const v = raw;
  for (const k of ["x", "y", "width", "height"]) {
    if (typeof v[k] !== "number" || !Number.isFinite(v[k])) return void 0;
  }
  const width = Math.floor(v.width);
  const height = Math.floor(v.height);
  if (width < 1 || height < 1) return void 0;
  const displayId = typeof v.displayId === "number" && Number.isFinite(v.displayId) ? Math.floor(v.displayId) : void 0;
  const spaceIndex = typeof v.spaceIndex === "number" && Number.isInteger(v.spaceIndex) && v.spaceIndex >= 0 ? v.spaceIndex : void 0;
  return {
    x: Math.floor(v.x),
    y: Math.floor(v.y),
    width,
    height,
    maximized: v.maximized === true,
    fullScreen: v.fullScreen === true,
    ...displayId !== void 0 ? { displayId } : {},
    ...spaceIndex !== void 0 ? { spaceIndex } : {}
  };
}
const MIN_VISIBLE_WIDTH = 100;
const MIN_VISIBLE_HEIGHT = 48;
function boundsOnScreen(bounds, displays) {
  if (!bounds) return void 0;
  const visible = displays.some((d) => {
    const overlapW = Math.min(bounds.x + bounds.width, d.x + d.width) - Math.max(bounds.x, d.x);
    const overlapH = Math.min(bounds.y + bounds.height, d.y + d.height) - Math.max(bounds.y, d.y);
    return overlapW >= MIN_VISIBLE_WIDTH && overlapH >= MIN_VISIBLE_HEIGHT;
  });
  return visible ? bounds : void 0;
}
const MAX_HISTORY = 5e3;
function recordVisit(list, visit) {
  const url2 = visit.url;
  const existing = list.find((e) => e.url === url2);
  const rest = list.filter((e) => e.url !== url2);
  const entry = existing ? {
    url: url2,
    // Keep the old title unless a fresh non-empty one supersedes it.
    title: visit.title && visit.title.trim() !== "" ? visit.title : existing.title,
    lastVisited: visit.at,
    visitCount: existing.visitCount + 1
  } : {
    url: url2,
    title: visit.title ?? "",
    lastVisited: visit.at,
    visitCount: 1
  };
  return [entry, ...rest].slice(0, MAX_HISTORY);
}
function recentHistory(list, limit) {
  return list.slice(0, Math.max(0, limit));
}
function scoreEntry(entry, q) {
  const title = entry.title.toLowerCase();
  const url2 = entry.url.toLowerCase();
  if (title.startsWith(q) || url2.startsWith(q)) return 3;
  if (title.includes(q) || url2.includes(q)) return 2;
  return 0;
}
function searchHistory(list, query, limit = 50) {
  const q = query.trim().toLowerCase();
  if (q === "") return recentHistory(list, limit);
  return list.map((e, i) => ({ e, i, s: scoreEntry(e, q) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i).slice(0, Math.max(0, limit)).map((x) => x.e);
}
function normalizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const v = item;
    if (typeof v.url !== "string" || v.url.trim() === "") continue;
    if (seen.has(v.url)) continue;
    seen.add(v.url);
    out.push({
      url: v.url,
      title: typeof v.title === "string" ? v.title : "",
      lastVisited: typeof v.lastVisited === "number" ? v.lastVisited : 0,
      visitCount: typeof v.visitCount === "number" && v.visitCount > 0 ? Math.floor(v.visitCount) : 1
    });
    if (out.length >= MAX_HISTORY) break;
  }
  return out;
}
const MAX_PERMISSIONS = 1e3;
function keyOf(origin, permission) {
  return `${origin}\0${permission}`;
}
function recordGrant(list, grant) {
  const { origin, permission, at } = grant;
  const k = keyOf(origin, permission);
  const existing = list.find((g) => keyOf(g.origin, g.permission) === k);
  const rest = list.filter((g) => keyOf(g.origin, g.permission) !== k);
  const entry = existing ? {
    origin,
    permission,
    firstGranted: existing.firstGranted,
    lastGranted: at,
    count: existing.count + 1
  } : { origin, permission, firstGranted: at, lastGranted: at, count: 1 };
  return [entry, ...rest].slice(0, MAX_PERMISSIONS);
}
function listGrants(list) {
  return list.slice();
}
function normalizePermissions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const v = item;
    if (typeof v.origin !== "string" || v.origin === "") continue;
    if (typeof v.permission !== "string" || v.permission === "") continue;
    const k = keyOf(v.origin, v.permission);
    if (seen.has(k)) continue;
    seen.add(k);
    const last = typeof v.lastGranted === "number" ? v.lastGranted : 0;
    out.push({
      origin: v.origin,
      permission: v.permission,
      firstGranted: typeof v.firstGranted === "number" ? v.firstGranted : last,
      lastGranted: last,
      count: typeof v.count === "number" && v.count > 0 ? Math.floor(v.count) : 1
    });
    if (out.length >= MAX_PERMISSIONS) break;
  }
  return out;
}
class ProfileData {
  constructor(deps) {
    this.deps = deps;
    this.history = deps.initialHistory;
    this.permissions = deps.initialPermissions;
    this.now = deps.now ?? Date.now;
  }
  deps;
  history;
  permissions;
  historyTimer = null;
  permissionsTimer = null;
  now;
  // --- History ---
  /** Record a page visit. Skips non-web urls (about:blank, mira://settings,
   * file://…) so only real browsing lands. Dedups by url (a re-visit bumps the
   * existing entry), then the write is debounced. */
  recordVisit(url2, title) {
    if (!/^https?:\/\//i.test(url2)) return;
    this.history = recordVisit(this.history, { url: url2, title, at: this.now() });
    this.scheduleHistoryFlush();
  }
  /** The most recent history entries, newest first (for the history command). */
  listHistory(limit) {
    return recentHistory(this.history, limit);
  }
  /** History entries matching `query` (url/title substring), newest first. */
  searchHistory(query, limit) {
    return searchHistory(this.history, query, limit);
  }
  /** Wipe the history and write the empty list NOW (cancelling any pending flush),
   * so a clear is durable even if the app quits immediately after. */
  clearHistory() {
    const cleared = this.history.length;
    this.history = [];
    if (this.historyTimer) {
      clearTimeout(this.historyTimer);
      this.historyTimer = null;
    }
    this.deps.persistHistory(this.history);
    return { cleared };
  }
  scheduleHistoryFlush() {
    if (this.historyTimer) return;
    this.historyTimer = setTimeout(() => {
      this.historyTimer = null;
      this.deps.persistHistory(this.history);
    }, this.deps.debounceMs);
  }
  // --- Permissions ---
  /** Record a granted permission, keyed by origin + permission (a re-grant bumps
   * the existing entry). Skips empty/opaque origins. The write is debounced, then
   * the Settings surface is nudged to refetch. */
  recordGrant(origin, permission) {
    if (!origin || origin === "null") return;
    this.permissions = recordGrant(this.permissions, { origin, permission, at: this.now() });
    this.schedulePermissionsFlush();
    this.deps.onPermissionsChanged();
  }
  /** The grant log as a display-ready list (for the Settings permissions view). */
  listPermissions() {
    return listGrants(this.permissions);
  }
  /** Wipe the grant log and write it NOW (cancelling any pending flush), then nudge
   * the Settings surface. Durable even on an immediate quit. */
  clearPermissions() {
    const cleared = this.permissions.length;
    this.permissions = [];
    if (this.permissionsTimer) {
      clearTimeout(this.permissionsTimer);
      this.permissionsTimer = null;
    }
    this.deps.persistPermissions(this.permissions);
    this.deps.onPermissionsChanged();
    return { cleared };
  }
  schedulePermissionsFlush() {
    if (this.permissionsTimer) return;
    this.permissionsTimer = setTimeout(() => {
      this.permissionsTimer = null;
      this.deps.persistPermissions(this.permissions);
    }, this.deps.debounceMs);
  }
  // --- Shutdown ---
  /** Cancel both pending debounced flushes and write the current lists now. Called
   * on app quit so the last few hundred ms of changes always land. */
  flush() {
    if (this.historyTimer) {
      clearTimeout(this.historyTimer);
      this.historyTimer = null;
    }
    this.deps.persistHistory(this.history);
    if (this.permissionsTimer) {
      clearTimeout(this.permissionsTimer);
      this.permissionsTimer = null;
    }
    this.deps.persistPermissions(this.permissions);
  }
  /** Cancel both pending debounced flushes WITHOUT writing. Used when an encrypted
   * profile locks: its plaintext files have just been copied into the vault and
   * wiped, so a lingering debounce timer must NOT fire and recreate them on disk
   * (that would leak decrypted trails past the lock). The instance is dropped right
   * after; the next unlock builds a fresh one from the restored files. */
  dispose() {
    if (this.historyTimer) {
      clearTimeout(this.historyTimer);
      this.historyTimer = null;
    }
    if (this.permissionsTimer) {
      clearTimeout(this.permissionsTimer);
      this.permissionsTimer = null;
    }
  }
}
function shouldGrantPermission(_permission) {
  return true;
}
function clientRectToScreen(rect, contentBounds) {
  return {
    x: contentBounds.x + rect.x,
    y: contentBounds.y + rect.y,
    width: rect.width,
    height: rect.height
  };
}
function tooltipBounds(anchor, size, workArea, opts) {
  const { gap, margin } = opts;
  const minX = workArea.x + margin;
  const maxX = workArea.x + workArea.width - size.width - margin;
  const minY = workArea.y + margin;
  const maxY = workArea.y + workArea.height - size.height - margin;
  let x = anchor.x + anchor.width / 2 - size.width / 2;
  x = clamp$1(x, minX, maxX);
  let y = anchor.y - size.height - gap;
  if (y < minY) y = anchor.y + anchor.height + gap;
  y = clamp$1(y, minY, maxY);
  return { x: Math.round(x), y: Math.round(y), width: size.width, height: size.height };
}
function clamp$1(v, lo, hi) {
  if (hi < lo) return lo;
  return Math.min(Math.max(v, lo), hi);
}
const PAD$1 = 16;
const TOOLTIP_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><style>
  html, body { margin: 0; background: transparent; }
  body { padding: ${PAD$1}px; }
  #b {
    display: inline-block;
    max-width: 360px;
    padding: 6px 10px;
    background: #282828;
    color: rgba(255, 255, 245, 0.86);
    border: 1px solid #414853;
    border-radius: 6px;
    font: 11px/1.35 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-variant-numeric: tabular-nums;
    /* pre-line keeps \\n breaks (tab tooltips are "title\\nurl") while still
       wrapping lines longer than max-width (long urls). */
    white-space: pre-line;
    overflow-wrap: break-word;
    box-shadow: 0 3px 12px rgba(0, 0, 0, 0.45);
  }
</style></head>
<body><div id="b"></div></body>
</html>`;
const TOOLTIP_URL = `data:text/html;charset=utf-8,${encodeURIComponent(TOOLTIP_HTML)}`;
function measureScript(text) {
  return `(() => {
    const el = document.getElementById('b')
    el.textContent = ${JSON.stringify(text)}
    const r = el.getBoundingClientRect()
    return { width: Math.ceil(r.width) + ${2 * PAD$1}, height: Math.ceil(r.height) + ${2 * PAD$1} }
  })()`;
}
function ensureTooltip(host) {
  const tip = new electron.BrowserWindow({
    parent: host.window,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    backgroundColor: "#00000000",
    width: 10,
    height: 10
  });
  tip.setIgnoreMouseEvents(true);
  host.tooltipReady = new Promise((resolve) => {
    tip.webContents.once("did-finish-load", () => resolve());
  });
  tip.loadURL(TOOLTIP_URL);
  host.tooltip = tip;
}
async function showTooltip(host, text, clientRect) {
  const tip = host.tooltip;
  if (!tip || tip.isDestroyed()) return;
  const seq = ++host.tooltipSeq;
  await host.tooltipReady;
  if (seq !== host.tooltipSeq || tip.isDestroyed() || host.window.isDestroyed()) return;
  const size = await tip.webContents.executeJavaScript(measureScript(text));
  if (seq !== host.tooltipSeq || tip.isDestroyed() || host.window.isDestroyed()) return;
  const anchor = clientRectToScreen(clientRect, host.window.getContentBounds());
  const display = electron.screen.getDisplayNearestPoint({
    x: Math.round(anchor.x),
    y: Math.round(anchor.y)
  });
  tip.setBounds(tooltipBounds(anchor, size, display.workArea, { gap: 6, margin: 4 }));
  tip.showInactive();
}
function hideTooltip(host) {
  host.tooltipSeq++;
  const tip = host.tooltip;
  if (tip && !tip.isDestroyed() && tip.isVisible()) tip.hide();
}
function destroyTooltip(host) {
  if (host.tooltip && !host.tooltip.isDestroyed()) host.tooltip.destroy();
  host.tooltip = null;
}
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function toastBounds(content, size, opts) {
  const { bottomGap, margin } = opts;
  const minX = content.x + margin;
  const maxX = content.x + content.width - size.width - margin;
  const minY = content.y + margin;
  const maxY = content.y + content.height - size.height - bottomGap;
  const x = clamp(content.x + content.width / 2 - size.width / 2, minX, maxX);
  const y = clamp(maxY, minY, maxY);
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: size.width,
    height: size.height
  };
}
const PAD = 24;
const SLIDE = 10;
const TOAST_DURATION_MS = 1800;
const TOAST_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><style>
  html, body { margin: 0; background: transparent; overflow: hidden; }
  body { padding: ${PAD}px; }
  #t {
    display: inline-block;
    max-width: 360px;
    padding: 8px 14px;
    background: #282828;
    color: rgba(255, 255, 245, 0.92);
    border: 1px solid #414853;
    border-radius: 999px;
    font: 12px/1.35 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-weight: 500;
    white-space: nowrap;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
    opacity: 0;
  }
  /* One class toggle plays the whole in-hold-out cycle. Restarted per toast by
     removing/re-adding the class with a reflow in between (see renderScript). */
  #t.show {
    animation: toast ${TOAST_DURATION_MS}ms ease forwards;
  }
  @keyframes toast {
    0%   { opacity: 0; transform: translateY(${SLIDE}px); }
    8%   { opacity: 1; transform: translateY(0); }
    88%  { opacity: 1; transform: translateY(0); }
    100% { opacity: 0; transform: translateY(-4px); }
  }
</style></head>
<body><div id="t"></div></body>
</html>`;
const TOAST_URL = `data:text/html;charset=utf-8,${encodeURIComponent(TOAST_HTML)}`;
function renderScript(message) {
  return `(() => {
    const el = document.getElementById('t')
    el.textContent = ${JSON.stringify(message)}
    el.classList.remove('show')
    void el.offsetWidth // force reflow so the animation restarts
    el.classList.add('show')
    const r = el.getBoundingClientRect()
    return { width: Math.ceil(r.width) + ${2 * PAD}, height: Math.ceil(r.height) + ${2 * PAD} }
  })()`;
}
function ensureToast(host) {
  const toast = new electron.BrowserWindow({
    parent: host.window,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    backgroundColor: "#00000000",
    width: 10,
    height: 10
  });
  toast.setIgnoreMouseEvents(true);
  host.toastReady = new Promise((resolve) => {
    toast.webContents.once("did-finish-load", () => resolve());
  });
  toast.loadURL(TOAST_URL);
  host.toast = toast;
}
async function showToast(host, message) {
  const toast = host.toast;
  if (!toast || toast.isDestroyed()) return;
  const seq = ++host.toastSeq;
  if (host.toastTimer) {
    clearTimeout(host.toastTimer);
    host.toastTimer = null;
  }
  await host.toastReady;
  if (seq !== host.toastSeq || toast.isDestroyed() || host.window.isDestroyed()) return;
  const size = await toast.webContents.executeJavaScript(renderScript(message));
  if (seq !== host.toastSeq || toast.isDestroyed() || host.window.isDestroyed()) return;
  toast.setBounds(toastBounds(host.window.getContentBounds(), size, { bottomGap: 44, margin: 8 }));
  toast.showInactive();
  host.toastTimer = setTimeout(() => {
    host.toastTimer = null;
    if (seq !== host.toastSeq) return;
    if (toast && !toast.isDestroyed() && toast.isVisible()) toast.hide();
  }, TOAST_DURATION_MS);
}
function destroyToast(host) {
  if (host.toastTimer) {
    clearTimeout(host.toastTimer);
    host.toastTimer = null;
  }
  if (host.toast && !host.toast.isDestroyed()) host.toast.destroy();
  host.toast = null;
}
function buildPageMenu(ctx) {
  const items = [
    { type: "command", command: "back", label: "Back", enabled: ctx.canGoBack },
    { type: "command", command: "forward", label: "Forward", enabled: ctx.canGoForward },
    { type: "command", command: "reload", label: "Reload", enabled: true }
  ];
  const mediaItem = buildMediaItem(ctx.mediaType, ctx.srcURL);
  if (mediaItem) items.push({ type: "separator" }, mediaItem);
  if (ctx.linkURL) {
    items.push(
      { type: "separator" },
      {
        type: "command",
        command: "new-tab",
        params: { url: ctx.linkURL },
        label: "Open Link in New Tab",
        enabled: true
      }
    );
  }
  if (ctx.isEditable) {
    items.push(
      { type: "separator" },
      { type: "role", role: "cut", label: "Cut" },
      { type: "role", role: "copy", label: "Copy" },
      { type: "role", role: "paste", label: "Paste" },
      { type: "role", role: "selectAll", label: "Select All" }
    );
  } else if (ctx.selectionText) {
    items.push({ type: "separator" }, { type: "role", role: "copy", label: "Copy" });
  }
  items.push({ type: "separator" }, { type: "inspect-element", label: "Inspect Element" });
  return items;
}
function buildMediaItem(mediaType, srcURL) {
  if (mediaType === "image" && srcURL) {
    return {
      type: "command",
      command: "download-media",
      params: { url: srcURL },
      label: "Download Image",
      enabled: true
    };
  }
  if (mediaType === "audio" && srcURL) {
    return {
      type: "command",
      command: "download-media",
      params: { url: srcURL },
      label: "Download Audio",
      enabled: true
    };
  }
  if (mediaType === "video") {
    const streamed = !srcURL || srcURL.startsWith("blob:");
    if (streamed) return { type: "download-stream", label: "Download Video" };
    return {
      type: "command",
      command: "download-media",
      params: { url: srcURL },
      label: "Download Video",
      enabled: true
    };
  }
  return null;
}
function buildTabMenu(tab, folders) {
  const items = [
    { type: "command", command: "new-tab", label: "New Tab", enabled: true },
    { type: "duplicate", label: "Duplicate Tab" }
  ];
  if (!tab.pinned) {
    const moveItems = folders.filter((f) => f.id !== tab.folderId).map((f) => ({
      type: "command",
      command: "move-tab-to-folder",
      params: { tabId: tab.id, folderId: f.id },
      label: f.title.trim() || "Untitled",
      enabled: true
    }));
    moveItems.push({
      type: "command",
      command: "create-tab-folder",
      params: { title: "New folder", tabId: tab.id },
      label: "New Folder…",
      enabled: true
    });
    items.push(
      { type: "separator" },
      { type: "submenu", label: "Move to Folder", items: moveItems }
    );
    if (tab.folderId !== null) {
      items.push({
        type: "command",
        command: "move-tab-to-folder",
        params: { tabId: tab.id, folderId: null },
        label: "Remove from Folder",
        enabled: true
      });
    }
  }
  items.push(
    { type: "separator" },
    tab.pinned ? {
      type: "command",
      command: "unpin-tab",
      params: { id: tab.id },
      label: "Unpin Tab",
      enabled: true
    } : {
      type: "command",
      command: "pin-tab",
      params: { id: tab.id },
      label: "Pin Tab",
      enabled: true
    },
    // Keep-awake toggle: mark the tab so it never sleeps (woken on restore, immune
    // to discard). The label reflects the tab's current state — there is no marker
    // on the tab itself, so this menu is the only place to see and flip it.
    {
      type: "command",
      command: "set-tab-awake",
      params: { id: tab.id, keepAwake: !tab.keepAwake },
      label: tab.keepAwake ? "Stop Keeping Awake" : "Keep Awake",
      enabled: true
    },
    { type: "separator" },
    {
      type: "command",
      command: "copy-tab-id",
      params: { id: tab.id },
      label: "Copy Tab ID",
      enabled: true
    },
    {
      type: "command",
      command: "close-tab",
      params: { id: tab.id },
      label: "Close Tab",
      enabled: true
    }
  );
  return items;
}
function labelFor(tab) {
  return tab.title.trim() || tab.url.trim() || "Untitled tab";
}
function buildAudioMenu(tabs) {
  if (tabs.length === 0) {
    return [{ type: "disabled", label: "No tabs playing audio" }];
  }
  return tabs.map((tab) => ({
    type: "command",
    command: "select-tab",
    params: { id: tab.id },
    label: labelFor(tab)
  }));
}
const FOLDER_COLORS = [
  { name: "Blue", value: "#4d7cfe" },
  { name: "Purple", value: "#8b5cf6" },
  { name: "Pink", value: "#ec4899" },
  { name: "Red", value: "#ef4444" },
  { name: "Orange", value: "#f97316" },
  { name: "Yellow", value: "#eab308" },
  { name: "Green", value: "#22c55e" },
  { name: "Teal", value: "#14b8a6" }
];
function buildFolderMenu(folder, colors = FOLDER_COLORS) {
  const colorItems = colors.map((c) => ({
    type: "command",
    command: "set-tab-folder-color",
    params: { id: folder.id, color: c.value },
    label: c.name,
    enabled: true,
    checked: folder.color !== null && folder.color.toLowerCase() === c.value.toLowerCase()
  }));
  colorItems.push(
    { type: "separator" },
    {
      type: "command",
      command: "set-tab-folder-color",
      params: { id: folder.id, color: null },
      label: "No Color",
      enabled: true,
      checked: folder.color === null
    }
  );
  return [
    {
      type: "command",
      command: "toggle-tab-folder",
      params: { id: folder.id },
      label: folder.collapsed ? "Expand Folder" : "Collapse Folder",
      enabled: true
    },
    { type: "separator" },
    { type: "submenu", label: "Color", items: colorItems },
    { type: "separator" },
    {
      type: "command",
      command: "remove-tab-folder",
      params: { id: folder.id },
      label: "Remove Folder",
      enabled: true
    }
  ];
}
const DEVTOOLS_FRACTION = 0.4;
const DEVTOOLS_MIN_WIDTH = 250;
function dockRight(area, fraction = DEVTOOLS_FRACTION) {
  const dtWidth = Math.min(
    area.width,
    Math.max(DEVTOOLS_MIN_WIDTH, Math.round(area.width * fraction))
  );
  const pageWidth = Math.max(0, area.width - dtWidth);
  return {
    page: { x: area.x, y: area.y, width: pageWidth, height: area.height },
    devtools: {
      x: area.x + pageWidth,
      y: area.y,
      width: area.width - pageWidth,
      height: area.height
    }
  };
}
function decideWindowOpen(details) {
  if (details.disposition === "new-window" || details.disposition === "new-popup") {
    return { kind: "popup" };
  }
  const referrer = details.referrer?.url || void 0;
  return { kind: "tab", url: details.url, referrer };
}
const JS_ACTION_LABEL = "Action JS";
const BINDING = "__miraHoverReport";
const EMPTY_HOVER = { targetUrl: "", jsAction: false };
function reduceHover(prev, event) {
  if (event.type === "target") {
    const navigable = event.url && !event.url.startsWith("javascript:");
    return { ...prev, targetUrl: navigable ? event.url : "" };
  }
  return { ...prev, jsAction: event.active };
}
function hoverText(state) {
  if (state.targetUrl) return state.targetUrl;
  return state.jsAction ? JS_ACTION_LABEL : "";
}
const DETECTOR_SOURCE = String.raw`
(() => {
  if (window.__miraHoverWired) return;
  window.__miraHoverWired = true;
  var SEL = 'button, [role="button"], [onclick], input[type="button"], input[type="submit"], input[type="reset"], a[href^="javascript:"]';
  var last = null;
  var report = function (active) {
    if (active === last) return;
    last = active;
    try { window.${BINDING}(active ? '1' : '0'); } catch (e) {}
  };
  var hitFrom = function (t) {
    return !!(t && t.closest && t.closest(SEL));
  };
  document.addEventListener('mouseover', function (e) { report(hitFrom(e.target)); }, true);
  document.addEventListener('mousemove', function (e) { report(hitFrom(e.target)); }, true);
  // Cursor leaving the document (relatedTarget null) clears the flag.
  document.addEventListener('mouseout', function (e) { if (!e.relatedTarget) report(false); }, true);
})();
`;
function installHoverReporter(wc, onJsHover) {
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    wc.debugger.sendCommand("Runtime.enable").then(() => wc.debugger.sendCommand("Runtime.addBinding", { name: BINDING })).catch((error) => console.error("[mira] hover: addBinding failed", error));
    wc.debugger.sendCommand("Page.enable").then(
      () => wc.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
        source: DETECTOR_SOURCE
      })
    ).catch((error) => console.error("[mira] hover: addScript failed", error));
  } catch (error) {
    console.error("[mira] hover: debugger attach failed", error);
  }
  wc.debugger.on("message", (_event, method, params) => {
    if (method !== "Runtime.bindingCalled") return;
    const p = params;
    if (p.name === BINDING) onJsHover(p.payload === "1");
  });
}
function interpretRuntimeEvaluate(reply) {
  const ex = reply.exceptionDetails;
  if (ex) {
    const message = ex.exception?.description ?? (typeof ex.exception?.value === "string" ? ex.exception.value : void 0) ?? ex.text ?? "evaluation failed";
    throw new Error(message);
  }
  const result = reply.result;
  if (!result) return void 0;
  if ("value" in result) return result.value;
  return result.description;
}
function withTimeout(p, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}
const EVAL_TIMEOUT_MS = 5e3;
async function evalInWebContents(wc, code) {
  if (wc.debugger.isAttached()) {
    try {
      const reply = await withTimeout(
        wc.debugger.sendCommand("Runtime.evaluate", {
          expression: code,
          returnByValue: true,
          awaitPromise: true,
          userGesture: true
        }),
        EVAL_TIMEOUT_MS,
        "cdp Runtime.evaluate"
      );
      return interpretRuntimeEvaluate(reply);
    } catch (error) {
      console.warn(
        `[cdp-eval] Runtime.evaluate failed, falling back to executeJavaScript: ${error}`
      );
    }
  }
  return withTimeout(wc.executeJavaScript(code, true), EVAL_TIMEOUT_MS, "executeJavaScript");
}
const MODIFIER_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const NAMED = {
  Enter: { code: "Enter", keyCode: 13 },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  " ": { code: "Space", keyCode: 32 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 }
};
function resolveKey(key) {
  if (typeof key !== "string" || key.length === 0) throw new Error("missing key");
  const named = NAMED[key];
  if (named) return { code: named.code, keyCode: named.keyCode, printable: false };
  if (key.length === 1) {
    const upper = key.toUpperCase();
    if (upper >= "A" && upper <= "Z") {
      return { code: `Key${upper}`, keyCode: upper.charCodeAt(0), printable: true };
    }
    if (key >= "0" && key <= "9") {
      return { code: `Digit${key}`, keyCode: key.charCodeAt(0), printable: true };
    }
    return { code: "", keyCode: upper.charCodeAt(0), printable: true };
  }
  throw new Error(`unsupported key: ${key}`);
}
function modifierMask(modifiers) {
  return modifiers.reduce((mask, m) => mask | (MODIFIER_BITS[m] ?? 0), 0);
}
function keyToDispatchEvents(key, modifiers = []) {
  const { code, keyCode, printable } = resolveKey(key);
  const mask = modifierMask(modifiers);
  const suppressed = MODIFIER_BITS.ctrl | MODIFIER_BITS.meta | MODIFIER_BITS.alt;
  const producesText = printable && (mask & suppressed) === 0;
  const base = {
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    modifiers: mask
  };
  const down = { type: "keyDown", ...base };
  if (producesText) {
    down.text = key;
    down.unmodifiedText = key;
  }
  return [down, { type: "keyUp", ...base }];
}
function enterFullScreen(tabId, current) {
  return { tabId, restore: current };
}
function panelChanged(episode, change) {
  return { ...episode, restore: { ...episode.restore, ...change } };
}
function exitFullScreen(episode) {
  return episode.restore;
}
const LOCATION_PERMISSION = "geolocation";
function decideLocationAction(permission, platform, status, alreadyOpenedSettings) {
  if (platform !== "darwin" || permission !== LOCATION_PERMISSION) return "noop";
  if (status === "not-determined") return "prompt";
  if (status === "denied" || status === "restricted") {
    return alreadyOpenedSettings ? "noop" : "open-settings";
  }
  return "noop";
}
function locationSettingsUrl(platform) {
  if (platform !== "darwin") return null;
  return "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_LocationServices";
}
const MEDIA_PICK_IPC_CHANNEL = "mira:media-device-pick";
const DEVICE_PICKER_CHOOSE_CHANNEL = "mira:media-picker:choose";
const DEVICE_PICKER_PRELOAD_SOURCE = `const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('miraDevicePicker', {
  choose: (payload) => ipcRenderer.send(${JSON.stringify(DEVICE_PICKER_CHOOSE_CHANNEL)}, String(payload || '')),
})
`;
function parsePickResult(raw) {
  if (typeof raw !== "string" || raw === "") return null;
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const video = typeof obj.video === "string" && obj.video ? obj.video : null;
  const audio = typeof obj.audio === "string" && obj.audio ? obj.audio : null;
  if (video === null && audio === null) return null;
  return { video, audio };
}
function escapeHtml$1(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function deviceDisplayName(device, index) {
  if (device.label) return device.label;
  const base = device.kind === "videoinput" ? "Camera" : "Microphone";
  return `${base} ${index + 1}`;
}
function renderDevicePickerHtml(req) {
  const column = (title, name, devices) => {
    if (!devices.length) return "";
    const rows = devices.map((d, i) => {
      const label = escapeHtml$1(deviceDisplayName(d, i));
      return `<label class="row">
          <input type="radio" name="${name}" value="${escapeHtml$1(d.deviceId)}"${i === 0 ? " checked" : ""} />
          <span class="dot"></span><span class="dname">${label}</span>
        </label>`;
    }).join("");
    return `<section><h2 class="group-title">${title}</h2><div class="rows">${rows}</div></section>`;
  };
  const videoCol = req.wantVideo ? column("Camera", "video", req.videoDevices) : "";
  const audioCol = req.wantAudio ? column("Microphone", "audio", req.audioDevices) : "";
  const nothing = !videoCol && !audioCol ? `<p class="empty">No camera or microphone is available. Check Camera &amp; Microphone access in System Settings &rsaquo; Privacy &amp; Security.</p>` : "";
  const origin = escapeHtml$1(req.origin || "This site");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font: 13px -apple-system, system-ui, sans-serif;
    background: #1e1e1e; color: #e8e8e8; user-select: none;
    display: flex; flex-direction: column; height: 100vh;
  }
  header { padding: 16px 20px 4px; }
  header h1 { margin: 0; font-size: 15px; font-weight: 600; }
  header .origin { color: #9a9a9a; font-size: 12px; margin-top: 2px; word-break: break-all; }
  main { flex: 1; overflow-y: auto; padding: 8px 20px 16px; display: flex; gap: 24px; }
  section { flex: 1; min-width: 0; }
  .group-title { font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
    color: #9a9a9a; margin: 12px 0 8px; }
  .rows { display: flex; flex-direction: column; gap: 4px; }
  .row { display: flex; align-items: center; gap: 8px; padding: 8px 10px;
    border-radius: 6px; cursor: pointer; transition: background .1s; }
  .row:hover { background: #2a2a2a; }
  .row input { position: absolute; opacity: 0; pointer-events: none; }
  .dot { width: 14px; height: 14px; flex: 0 0 auto; border-radius: 50%;
    border: 1.5px solid #6a6a6a; transition: border-color .1s, box-shadow .1s; }
  .row input:checked ~ .dot { border-color: #4c8bf5; box-shadow: inset 0 0 0 3px #4c8bf5; }
  .row:has(input:checked) { background: #2f3947; }
  .dname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { color: #9a9a9a; line-height: 1.5; }
  footer { padding: 12px 20px; border-top: 1px solid #333; display: flex;
    justify-content: flex-end; gap: 8px; }
  button { border: none; border-radius: 6px; padding: 7px 16px; font: inherit; cursor: pointer; }
  .cancel { background: #3a3a3a; color: #e8e8e8; }
  .cancel:hover { background: #454545; }
  .allow { background: #4c8bf5; color: #fff; }
  .allow:hover { background: #5a95f6; }
  .allow:disabled { background: #333; color: #777; cursor: default; }
</style>
</head>
<body>
  <header>
    <h1>Share camera &amp; microphone</h1>
    <div class="origin">${origin}</div>
  </header>
  <main>${videoCol}${audioCol}${nothing}</main>
  <footer>
    <button class="cancel" type="button" onclick="cancel()">Cancel</button>
    <button class="allow" type="button" onclick="allow()"${nothing ? " disabled" : ""}>Allow</button>
  </footer>
  <script>
    function pick(name) {
      var el = document.querySelector('input[name="' + name + '"]:checked');
      return el ? el.value : null;
    }
    function allow() {
      miraDevicePicker.choose(JSON.stringify({ video: pick('video'), audio: pick('audio') }));
    }
    function cancel() { miraDevicePicker.choose(''); }
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') cancel();
      else if (e.key === 'Enter') allow();
    });
  <\/script>
</body>
</html>`;
}
function showMediaDevicePicker(req, opts) {
  const win = new electron.BrowserWindow({
    parent: opts.parent ?? void 0,
    modal: opts.parent != null,
    width: 520,
    height: 420,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Share camera & microphone",
    backgroundColor: "#1e1e1e",
    show: false,
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.setMenuBarVisibility(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      if (!win.isDestroyed()) win.close();
    };
    win.webContents.ipc.on(DEVICE_PICKER_CHOOSE_CHANNEL, (_event, raw) => {
      finish(parsePickResult(raw));
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.once("ready-to-show", () => win.show());
    win.on("closed", () => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    });
    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(renderDevicePickerHtml(req))).catch(() => finish(null));
  });
}
const GUM_SHIM_MAIN_WORLD = `(bridge) => {
  var md = navigator.mediaDevices;
  if (!md || typeof md.getUserMedia !== 'function' || md.__miraPicker || !bridge) return;
  md.__miraPicker = true;
  var orig = md.getUserMedia.bind(md);
  var withDeviceId = function (value, id) {
    var base = value && typeof value === 'object' ? Object.assign({}, value) : {};
    base.deviceId = { exact: id };
    return base;
  };
  md.getUserMedia = function (constraints) {
    try {
      var c = constraints || {};
      var wantVideo = !!c.video, wantAudio = !!c.audio;
      if (!wantVideo && !wantAudio) return orig(constraints);
      return md.enumerateDevices().then(function (devices) {
        var reduce = function (kind) {
          return devices.filter(function (d) { return d.kind === kind; })
            .map(function (d) { return { deviceId: d.deviceId, label: d.label, kind: d.kind }; });
        };
        var request = {
          origin: location.origin,
          wantVideo: wantVideo, wantAudio: wantAudio,
          videoDevices: reduce('videoinput'),
          audioDevices: reduce('audioinput')
        };
        return Promise.resolve(bridge.pickDevices(request)).then(function (choice) {
          if (!choice) throw new DOMException('Permission denied by user', 'NotAllowedError');
          var next = Object.assign({}, c);
          if (wantVideo && choice.video) next.video = withDeviceId(c.video, choice.video);
          if (wantAudio && choice.audio) next.audio = withDeviceId(c.audio, choice.audio);
          return orig(next);
        }, function (err) {
          // IPC/bridge failure (NOT a user cancel) — do not block the user.
          if (err && err.name === 'NotAllowedError') throw err;
          return orig(constraints);
        });
      }, function () { return orig(constraints); });
    } catch (e) {
      return orig(constraints);
    }
  };
}`;
const GUM_SHIM_PRELOAD_SOURCE = `(function () {
  var electron = require('electron');
  var contextBridge = electron.contextBridge;
  var ipcRenderer = electron.ipcRenderer;
  if (!ipcRenderer) return;
  var CHANNEL = ${JSON.stringify(MEDIA_PICK_IPC_CHANNEL)};
  var bridge = {
    pickDevices: function (request) { return ipcRenderer.invoke(CHANNEL, request); }
  };
  var install = ${GUM_SHIM_MAIN_WORLD};
  try {
    if (contextBridge && typeof contextBridge.executeInMainWorld === 'function') {
      contextBridge.executeInMainWorld({ func: install, args: [bridge] });
      return;
    }
  } catch (_) { /* fall through */ }
  install(bridge);
})();
`;
function normalizePickRequest(payload) {
  const p = payload ?? {};
  const devices = (raw, kind) => Array.isArray(raw) ? raw.map((d) => d).filter((d) => d && typeof d.deviceId === "string" && d.deviceId).map((d) => ({ deviceId: d.deviceId, label: String(d.label ?? ""), kind })) : [];
  return {
    origin: typeof p.origin === "string" ? p.origin : "",
    wantVideo: !!p.wantVideo,
    wantAudio: !!p.wantAudio,
    videoDevices: devices(p.videoDevices, "videoinput"),
    audioDevices: devices(p.audioDevices, "audioinput")
  };
}
class MediaDevicePickerService {
  constructor(userDataDir) {
    this.userDataDir = userDataDir;
  }
  userDataDir;
  shimPreloadPath = null;
  pickerPreloadPath = null;
  ipcInstalled = false;
  /** One picker at a time — a second request while one is up is denied (cancel),
   * mirroring ExtensionCaptureService.pickerOpen. */
  pickerOpen = false;
  attached = /* @__PURE__ */ new WeakSet();
  /** Install the ipc handler (once) and register the shim preload on `ses`
   * (once per session). Call for each web-page session. */
  attach(ses) {
    this.installIpc();
    if (this.attached.has(ses)) return;
    this.attached.add(ses);
    ses.registerPreloadScript({
      id: "mira-media-device-picker",
      type: "frame",
      filePath: this.ensureShimPreload()
    });
  }
  installIpc() {
    if (this.ipcInstalled) return;
    this.ipcInstalled = true;
    electron.ipcMain.handle(MEDIA_PICK_IPC_CHANNEL, (_event, payload) => this.pick(payload));
  }
  /** Show the picker for one getUserMedia request and resolve the choice, or null
   * to cancel (a picker already up, or nothing to pick). */
  async pick(payload) {
    if (this.pickerOpen) return null;
    const request = normalizePickRequest(payload);
    const hasVideo = request.wantVideo && request.videoDevices.length > 0;
    const hasAudio = request.wantAudio && request.audioDevices.length > 0;
    if (!hasVideo && !hasAudio) return { video: null, audio: null };
    this.pickerOpen = true;
    try {
      return await showMediaDevicePicker(request, {
        parent: electron.BrowserWindow.getFocusedWindow(),
        preloadPath: this.ensurePickerPreload()
      });
    } finally {
      this.pickerOpen = false;
    }
  }
  ensureShimPreload() {
    return this.shimPreloadPath ??= this.writeShim(
      "media-device-picker-shim.js",
      GUM_SHIM_PRELOAD_SOURCE
    );
  }
  ensurePickerPreload() {
    return this.pickerPreloadPath ??= this.writeShim(
      "media-device-picker-preload.js",
      DEVICE_PICKER_PRELOAD_SOURCE
    );
  }
  writeShim(name, source) {
    const dir = path.join(this.userDataDir, "sw-shims");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const path$1 = path.join(dir, name);
    fs.writeFileSync(path$1, source, "utf8");
    return path$1;
  }
}
const USER_SPACE = 0;
function userSpaceIds(display) {
  return display.spaces.filter((s) => s.type === USER_SPACE).map((s) => s.id);
}
function windowSpaceLocation(layout, windowSpaceIds) {
  for (const display of layout) {
    const ids = userSpaceIds(display);
    for (const spaceId of windowSpaceIds) {
      const index = ids.indexOf(spaceId);
      if (index !== -1) return { displayId: display.displayId, spaceIndex: index };
    }
  }
  return void 0;
}
function resolveTargetSpaceId(layout, savedDisplayId, spaceIndex) {
  const display = layout.find((d) => d.displayId === savedDisplayId) ?? layout[0];
  if (!display) return void 0;
  const ids = userSpaceIds(display);
  const target = ids[spaceIndex];
  if (target === void 0 || target === display.currentSpaceId) return void 0;
  return target;
}
function parseWindowNumber(mediaSourceId) {
  const parts = mediaSourceId.split(":");
  if (parts.length < 2 || parts[0] !== "window") return void 0;
  const n = Number(parts[1]);
  return Number.isInteger(n) && n > 0 ? n : void 0;
}
const nativeRequire$1 = module$1.createRequire(__filename);
let addon$1 = null;
let loadAttempted$1 = false;
function loadAddon$1() {
  if (loadAttempted$1) return addon$1;
  loadAttempted$1 = true;
  if (process.platform !== "darwin") return null;
  const candidate = electron.app.isPackaged ? path.join(process.resourcesPath, "mira_spaces.node") : path.join(__dirname, "../../native/mira-spaces/build/Release/mira_spaces.node");
  try {
    addon$1 = nativeRequire$1(candidate);
  } catch (error) {
    console.error("[mira] mac-spaces addon not loaded:", error);
    addon$1 = null;
  }
  return addon$1;
}
function spacesLayout() {
  const a = loadAddon$1();
  if (!a) return [];
  try {
    return a.spacesLayout();
  } catch (error) {
    console.error("[mira] spacesLayout failed:", error);
    return [];
  }
}
function windowSpaces(windowNumber) {
  const a = loadAddon$1();
  if (!a) return [];
  try {
    return a.windowSpaces(windowNumber);
  } catch (error) {
    console.error("[mira] windowSpaces failed:", error);
    return [];
  }
}
function moveWindowToSpace(windowNumber, spaceId) {
  const a = loadAddon$1();
  if (!a) return false;
  try {
    return a.moveWindowToSpace(windowNumber, spaceId);
  } catch (error) {
    console.error("[mira] moveWindowToSpace failed:", error);
    return false;
  }
}
const nativeRequire = module$1.createRequire(__filename);
let addon = null;
let loadAttempted = false;
function loadAddon() {
  if (loadAttempted) return addon;
  loadAttempted = true;
  if (process.platform !== "darwin") return null;
  const candidate = electron.app.isPackaged ? path.join(process.resourcesPath, "mira_location.node") : path.join(__dirname, "../../native/mira-location/build/Release/mira_location.node");
  try {
    addon = nativeRequire(candidate);
  } catch (error) {
    console.error("[mira] mac-location addon not loaded:", error);
    addon = null;
  }
  return addon;
}
function locationAuthStatus() {
  const a = loadAddon();
  if (!a) return "unavailable";
  try {
    return a.authorizationStatus();
  } catch (error) {
    console.error("[mira] locationAuthStatus failed:", error);
    return "unavailable";
  }
}
function requestLocationAuthorization() {
  const a = loadAddon();
  if (!a) return "unavailable";
  try {
    return a.requestAuthorization();
  } catch (error) {
    console.error("[mira] requestLocationAuthorization failed:", error);
    return "unavailable";
  }
}
const SIDEBAR_WIDTH = { min: 160, max: 480, default: 240 };
const SKILL_PANE_WIDTH = { min: 260, max: 720, default: 360 };
function clampWidth(width, range) {
  if (typeof width !== "number" || !Number.isFinite(width)) return range.default;
  return Math.round(Math.max(range.min, Math.min(range.max, width)));
}
const DEFAULT_HOME_URL = "https://www.google.com";
function defaultLlm() {
  return { provider: "claude-cli" };
}
function defaultSettings() {
  return {
    homeUrl: DEFAULT_HOME_URL,
    llm: defaultLlm(),
    sidebarWidth: SIDEBAR_WIDTH.default,
    skillPaneWidth: SKILL_PANE_WIDTH.default
  };
}
function normalizeLlm(raw) {
  if (!raw || typeof raw !== "object") return defaultLlm();
  const v = raw;
  const provider = LLM_PROVIDERS.includes(v.provider) ? v.provider : defaultLlm().provider;
  const config = { provider };
  if (typeof v.apiKey === "string" && v.apiKey.trim() !== "") config.apiKey = v.apiKey.trim();
  if (typeof v.model === "string" && v.model.trim() !== "") config.model = v.model.trim();
  if (typeof v.loadMcp === "boolean") config.loadMcp = v.loadMcp;
  return config;
}
function normalizeSettings(raw) {
  if (!raw || typeof raw !== "object") return defaultSettings();
  const v = raw;
  const homeUrl = typeof v.homeUrl === "string" ? v.homeUrl.trim() : DEFAULT_HOME_URL;
  return {
    homeUrl,
    llm: normalizeLlm(v.llm),
    sidebarWidth: clampWidth(v.sidebarWidth, SIDEBAR_WIDTH),
    skillPaneWidth: clampWidth(v.skillPaneWidth, SKILL_PANE_WIDTH)
  };
}
function withHomeUrl(settings, url2) {
  return { ...settings, homeUrl: url2.trim() };
}
function withLlm(settings, llm) {
  return { ...settings, llm: normalizeLlm(llm) };
}
function withSidebarWidth(settings, width) {
  return { ...settings, sidebarWidth: clampWidth(width, SIDEBAR_WIDTH) };
}
function withSkillPaneWidth(settings, width) {
  return { ...settings, skillPaneWidth: clampWidth(width, SKILL_PANE_WIDTH) };
}
const SETTINGS_URL = "mira://settings";
const REVEAL_COOKIES_SCRIPT = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 50; i++) {
    try {
      const UI = await import('./ui/legacy/legacy.js')
      const app = await import('./panels/application/application.js')
      await UI.ViewManager.ViewManager.instance().showView('resources')
      const panel = app.ResourcesPanel.ResourcesPanel.instance()
      const cookies = panel.sidebar.cookieListTreeElement
      cookies.expand()
      const first = cookies.firstChild()
      ;(first || cookies).revealAndSelect()
      return true
    } catch (e) {
      await wait(100)
    }
  }
  return false
})()`;
function originOf(url2) {
  try {
    return new URL(url2).origin;
  } catch {
    return url2;
  }
}
const CLOSED_TAB_STACK_LIMIT = 25;
function uniqueFileName(name, dir, used) {
  const taken = (n) => used.has(n) || node_fs.existsSync(node_path.join(dir, n));
  if (!taken(name)) return name;
  const ext = node_path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; i < 1e4; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!taken(candidate)) return candidate;
  }
  return name;
}
class ProfileManager {
  constructor(deps) {
    this.deps = deps;
    this.profiles = deps.initialProfiles;
    this.themes = deps.initialThemes;
    this.sessions = deps.initialSessions;
    this.appSettings = {
      homeUrl: deps.homeUrl,
      llm: deps.initialLlm,
      sidebarWidth: deps.sidebarWidth,
      skillPaneWidth: deps.skillPaneWidth
    };
  }
  deps;
  /** How long to coalesce disk writes / strip pushes / resize layouts. Page
   * events (title, favicon, in-page navigation) fire in bursts; batching them
   * turns a storm of work per event into one write / push / layout per window. */
  static SAVE_DEBOUNCE_MS = 500;
  static PUSH_DEBOUNCE_MS = 120;
  static LAYOUT_THROTTLE_MS = 16;
  /** Every known profile (open or not). Mirrors profiles.json. */
  profiles;
  /** Every theme (built-ins + custom). Mirrors themes.json (custom part). */
  themes;
  /** Every profile's last window state (open or not). Mirrors sessions.json;
   * a closed profile keeps its saved tabs until it is reopened. */
  sessions;
  /** Each profile's favorites tree + its mutations (bookmarks-controller.ts). ONE
   * BookmarksController PER PROFILE id, created lazily by bookmarksFor(): a
   * profile's favorites live in its own file and never leak into another's. */
  bookmarksById = /* @__PURE__ */ new Map();
  /** Live app settings (home URL, …). Mirrors settings.json; seeded from
   * deps.homeUrl and updated in place by set-home-url. */
  appSettings;
  /** Set while stepMruIn is driving a Cmd+Alt+Left/Right cursor move: the tab
   * switch it triggers must NOT be recorded as a fresh MRU visit (that would
   * corrupt the very history we're walking). Read by recordMruVisit. */
  mruSuppressRecord = false;
  /** Debounce for persisting settings during a panel resize drag: many width
   * updates per second update the layout live, but only settle to disk once idle. */
  settingsSaveTimer = null;
  /** Each profile's browsing trails — history + web-permission grants — with their
   * debounced writes (profile-data.ts). ONE ProfileData PER PROFILE id, created
   * lazily by dataFor(): a profile's history/permissions live in its own files and
   * never leak into another's. */
  dataById = /* @__PURE__ */ new Map();
  /** Session partitions whose permission handlers are already installed, so we
   * set them once per profile session and not on every tab. Keyed by partition
   * (the default session uses '' as its key). */
  permissionSessions = /* @__PURE__ */ new Set();
  /** The camera/mic picker wiring (getUserMedia shim preload + native picker),
   * shared across profile sessions. Lazily created so `app` is ready first. */
  mediaPicker = null;
  /** True once we've auto-opened the OS Location Services pane this run, so the
   * permission handler firing repeatedly doesn't reopen System Settings. */
  locationSettingsOpened = false;
  /** True once we've fired the native location prompt this run, so the permission
   * handler firing repeatedly doesn't re-invoke it (CoreLocation coalesces, but we
   * avoid the churn). Resets only on app restart. */
  locationPromptRequested = false;
  /** The AI engine behind the skill summary and page chat (run-skill / run-prompt).
   * Stateless dispatcher over the configured provider — extracted from this class
   * (see llm-runner.ts); reads the live provider from this.appSettings.llm. */
  llm = new LlmRunner();
  /** Encrypted profiles unlocked THIS session, id → the password used to unlock
   * (kept in memory so we can re-lock — mount + copy back — without re-prompting).
   * A profile in this map has its plaintext data live on disk; absent = locked.
   * The password is cleared on lock. */
  unlockedVaults = /* @__PURE__ */ new Map();
  /** Encrypted profiles unlocked THIS session, id → their per-unlock partition
   * STRING (`persist:mira-<id>-<nonce>`). A fresh nonce each unlock gives Electron a
   * never-seen session that reads the just-restored cookies, dodging its
   * app-lifetime session cache (which would otherwise serve a stale/empty session on
   * a second unlock — the cookie-loss bug). Absent = locked (falls back to the
   * canonical partition). Set on unlock, cleared on lock. See noncePartitionDir. */
  unlockedPartition = /* @__PURE__ */ new Map();
  /** Every currently open window, keyed by its unique windowId. A profile may have
   * several entries here (a torn-off tab lives in its own window of the same
   * profile), so this is NOT keyed by profile id — use windowsForProfile /
   * aWindowForProfile to resolve a profile's window(s). */
  openById = /* @__PURE__ */ new Map();
  /** yt-dlp video downloads in flight, keyed by a unique id, with when each
   * started. A download runs in a background process (independent of any UI), so
   * this lets the status bar show one is running and how long it has taken. */
  activeDownloads = /* @__PURE__ */ new Map();
  /** Monotonic id for activeDownloads entries (two downloads of the same url must
   * be tracked distinctly). */
  downloadSeq = 0;
  /** Native browser file downloads (a page-triggered file save, distinct from the
   * yt-dlp video grabs above). The pure tracker holds the records; the live
   * DownloadItem handles (needed to cancel) are kept alongside, keyed by the same
   * minted id. Sessions we have already hooked with will-download are recorded so
   * the hook installs once per partition. */
  downloadTracker = new DownloadTracker();
  downloadItems = /* @__PURE__ */ new Map();
  downloadSessions = /* @__PURE__ */ new Set();
  /** Pending debounced flush of sessions.json (one timer for the whole app, as
   * there is a single file). null when no write is pending. */
  saveTimer = null;
  /** Profile id currently checked in the app menu's Profiles submenu. Used to
   * skip a full menu rebuild when a window is merely re-focused (same profile). */
  menuFocusId = null;
  /** True once the app has begun quitting (app 'before-quit'). At quit every open
   * window closes and fires 'closed' just like a user close would — this flag lets
   * the close path tell the two apart: a user close marks the profile not-open
   * (so it won't reopen), a quit leaves the open flag alone (so it will). */
  quitting = false;
  /** True only while lockAllVaults() is closing+locking every unlocked vault (a
   * bulk lock, e.g. on quit). It tells the window 'closed' handler to NOT also fire
   * its own auto-lock for that profile — lockAllVaults locks each one explicitly,
   * so without this both would race on the same vault (double hdiutil mount/copy). */
  lockingAll = false;
  /** True only while openSavedProfiles() recreates the windows of the previous
   * session. Windows created then are put back on their saved virtual desktop;
   * a window opened later (user action) opens on the CURRENT desktop instead —
   * teleporting a window the user just asked for would read as "nothing
   * happened". Its saved spaceIndex is refreshed by the next focus/close. */
  restoringStartup = false;
  /** Persistent optical magnifier zoom/pan, per content-tab id (absent = 100%).
   * Not in tab-store: it is native view state (a CDP clip), rebuilt from scratch
   * on navigation, never persisted. See magnifier.ts. */
  magnifierStates = /* @__PURE__ */ new Map();
  /** Last shim flags pushed per tab id, to avoid re-evaluating JS every wheel. */
  shimFlags = /* @__PURE__ */ new Map();
  /** The ProfileData for a profile id, created (and its files loaded) on first use.
   * One per profile so history/permissions stay isolated; the permissions-changed
   * broadcast is scoped to THAT profile's window (one window per profile). */
  dataFor(id) {
    const existing = this.dataById.get(id);
    if (existing) return existing;
    const data = new ProfileData({
      initialHistory: this.deps.loadProfileHistory(id),
      persistHistory: (history) => this.deps.persistProfileHistory(id, history),
      initialPermissions: this.deps.loadProfilePermissions(id),
      persistPermissions: (permissions) => this.deps.persistProfilePermissions(id, permissions),
      // Ping this profile's window(s) so an open Settings tab refetches the grant
      // list — a profile may have several windows, so fan out to all of them.
      onPermissionsChanged: () => {
        this.broadcastToProfile(id, "mira:permissions-changed");
      },
      debounceMs: ProfileManager.SAVE_DEBOUNCE_MS
    });
    this.dataById.set(id, data);
    return data;
  }
  /** The BookmarksController for a profile id, created (and its file loaded) on
   * first use. One per profile so favorites stay isolated; a change refreshes only
   * THAT profile's window star, and rebuilds the native menu (it renders the
   * focused profile's tree — see listBookmarksTree). */
  bookmarksFor(id) {
    const existing = this.bookmarksById.get(id);
    if (existing) return existing;
    const controller = new BookmarksController({
      initial: this.deps.loadProfileBookmarks(id),
      persist: (tree) => this.deps.persistProfileBookmarks(id, tree),
      onChange: (tree) => {
        this.broadcastToProfile(id, "mira:bookmarks-changed", { tree });
        this.deps.onBookmarksChange?.();
      }
    });
    this.bookmarksById.set(id, controller);
    return controller;
  }
  // --- Encrypted profile (vault) ---
  // The pure plan/paths are in vault.ts; the hdiutil + copy/wipe I/O in
  // vault-service.ts. encrypt() and lock() WIPE the plaintext (after a verified
  // copy), so both require the profile's window to be CLOSED first, so Electron has
  // released the session partition's file handles. Auto-lock on window close is a
  // deferred follow-up (see track.md).
  /** Turn a profile into a password-protected one: create its vault, move its data
   * in, wipe the plaintext, mark it encrypted. Leaves it LOCKED (no plaintext on
   * disk). Throws on the default profile (vaultPlan), an already-encrypted or open
   * profile. */
  async encryptProfileVault(id, password) {
    const profile = findById(this.profiles, id);
    if (!profile) throw new Error(`unknown profile: ${id}`);
    if (profile.encrypted) throw new Error(`already encrypted: ${id}`);
    if (this.windowsForProfile(id).length > 0)
      throw new Error("close the profile window before encrypting it");
    const ses = this.sessionFor(id);
    await ses.cookies.flushStore().catch(() => {
    });
    ses.flushStorageData();
    const plan = vaultPlan(this.deps.userDataDir, id);
    await encrypt(plan, password);
    this.profiles = this.profiles.map((p) => p.id === id ? { ...p, encrypted: true } : p);
    this.deps.persist(this.profiles);
    this.deps.onChange?.();
    return { id };
  }
  /** Unlock an encrypted profile for this session: mount its vault and copy the data
   * back to the normal userData locations, and remember the password (in memory) so
   * we can re-lock without re-prompting. Throws on a wrong password / not-encrypted. */
  async unlockProfileVault(id, password) {
    const profile = findById(this.profiles, id);
    if (!profile) throw new Error(`unknown profile: ${id}`);
    if (!profile.encrypted) throw new Error(`not encrypted: ${id}`);
    if (this.unlockedVaults.has(id)) return { id };
    const partitionDir = noncePartitionDir(id, crypto.randomUUID());
    const plan = vaultPlan(this.deps.userDataDir, id, partitionDir);
    await unlock(plan, password);
    this.unlockedVaults.set(id, password);
    this.unlockedPartition.set(id, `persist:${partitionDir}`);
    this.evictProfileDataCaches(id);
    this.deps.onChange?.();
    return { id };
  }
  /** Lock an unlocked encrypted profile: copy the live data back into the vault and
   * wipe the plaintext, using the in-memory password. Requires the window closed
   * (handles released). No-op-safe (locked:false) if already locked. */
  async lockProfileVault(id) {
    const profile = findById(this.profiles, id);
    if (!profile) throw new Error(`unknown profile: ${id}`);
    if (!profile.encrypted) throw new Error(`not encrypted: ${id}`);
    const password = this.unlockedVaults.get(id);
    if (password === void 0) return { id, locked: false };
    if (this.windowsForProfile(id).length > 0)
      throw new Error("close the profile window before locking it");
    await this.performVaultLock(id, password);
    return { id, locked: true };
  }
  /** The actual lock work, shared by the command path (lockProfileVault, which
   * first requires the window closed) and the bulk path (lockAllVaults, which
   * closes the windows itself). Assumes the profile's window is already gone
   * (handles released) and that it is unlocked with `password`. Flushes the live
   * session to disk, copies it into the vault, wipes the plaintext, clears state. */
  async performVaultLock(id, password) {
    this.dataById.get(id)?.flush();
    const ses = this.sessionFor(id);
    await ses.cookies.flushStore().catch(() => {
    });
    ses.flushStorageData();
    const partition = this.unlockedPartition.get(id);
    const partitionDir = partition ? partition.replace(/^persist:/, "") : void 0;
    const plan = vaultPlan(this.deps.userDataDir, id, partitionDir);
    await lock(plan, password);
    this.unlockedVaults.delete(id);
    this.unlockedPartition.delete(id);
    this.evictProfileDataCaches(id);
    this.deps.onChange?.();
  }
  /** Whether any encrypted profile is currently unlocked (has live plaintext on
   * disk). index.ts checks this on 'before-quit' to decide whether to defer the
   * quit and re-lock first. */
  hasUnlockedVaults() {
    return this.unlockedVaults.size > 0;
  }
  /** Lock EVERY currently-unlocked vault: close each one's window (so its file
   * handles are released), then copy its live data back into the vault and wipe the
   * plaintext. Called on app quit so a session left unlocked is preserved instead of
   * discarded by reconcile at next startup — and pilotable as `lock-all-vaults` (a
   * panic-lock). Best-effort per profile: one failure is logged, the rest proceed. */
  async lockAllVaults() {
    this.lockingAll = true;
    const locked = [];
    try {
      for (const id of [...this.unlockedVaults.keys()]) {
        const password = this.unlockedVaults.get(id);
        if (password === void 0) continue;
        try {
          await this.closeWindowAndWait(id);
          await this.performVaultLock(id, password);
          locked.push(id);
        } catch (error) {
          console.error(`[mira] lock-all of profile ${id} failed`, error);
        }
      }
    } finally {
      this.lockingAll = false;
    }
    return { locked };
  }
  /** Close ALL windows of a profile (a profile may have several after a tear-off)
   * and resolve once every one is gone. Prefers a graceful close() (fires the
   * 'close'/'closed' bookkeeping, e.g. geometry save), with a forced destroy()
   * fallback if a page's beforeunload stalls it. The lockingAll flag keeps the
   * 'closed' handler from double-locking underneath us. */
  closeWindowAndWait(id) {
    const windows = this.windowsForProfile(id);
    if (windows.length === 0) return Promise.resolve();
    return Promise.all(
      windows.map(
        (pw) => new Promise((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            resolve();
          };
          pw.window.once("closed", finish);
          pw.window.close();
          setTimeout(() => {
            if (!pw.window.isDestroyed()) pw.window.destroy();
            finish();
          }, 2e3);
        })
      )
    ).then(() => void 0);
  }
  /** Drop a profile's cached history/permissions and bookmarks readers, cancelling
   * any pending debounced write first (dispose, NOT flush — the caller has already
   * persisted what it wanted to keep). Used on vault lock/unlock so these in-memory
   * readers never outlive a vault swap: a stale reader would either serve old data
   * or recreate wiped plaintext on its next debounce. */
  evictProfileDataCaches(id) {
    this.dataById.get(id)?.dispose();
    this.dataById.delete(id);
    this.bookmarksById.delete(id);
  }
  /** The encrypted-profile state: which profiles are encrypted, which are unlocked. */
  listVaultsState() {
    return {
      encrypted: this.profiles.filter((p) => p.encrypted).map((p) => p.id),
      unlocked: [...this.unlockedVaults.keys()]
    };
  }
  /** At startup, discard any leftover plaintext of encrypted profiles. An unclean
   * shutdown (crash, or quit while unlocked) can leave a profile's data decrypted on
   * disk; nothing is unlocked yet, so any such plaintext is stale — wipe it and let
   * the vault (last clean lock) be the truth. Losing that unclean session is fine
   * (CONFIRMED). Best-effort per profile. */
  reconcileVaults() {
    for (const p of this.profiles) {
      if (!p.encrypted) continue;
      try {
        discardProfilePlaintext(this.deps.userDataDir, p.id);
      } catch (error) {
        console.error(`[mira] vault reconcile of profile ${p.id} failed`, error);
      }
    }
  }
  /** Reopen, at startup, exactly the set of profile windows that were open when
   * Mira last quit (one window per open profile, see PersistedWindow.open). Skips
   * unknown ids (a session for a profile since deleted). Falls back to the default
   * profile when none is marked open — e.g. a first launch, or a fresh install.
   * Only THIS path restores each window's virtual desktop: it recreates a world
   * the user left, whereas a later explicit open must land on the desktop the
   * user is looking at (see restoringStartup / create()). */
  openSavedProfiles(explicitProfileId) {
    this.reconcileVaults();
    this.restoringStartup = true;
    try {
      if (explicitProfileId) {
        if (findById(this.profiles, explicitProfileId)) {
          this.openProfile(explicitProfileId);
          return;
        }
        console.warn(`[profiles] --profile: unknown id ${explicitProfileId}, ignoring`);
      }
      const unlocked = new Set(this.unlockedVaults.keys());
      const toOpen = this.profiles.filter(
        (p) => this.savedWindows(p.id).some((w) => w.open === true) && !needsUnlock(p, unlocked)
      );
      if (toOpen.length === 0) {
        this.openProfile(DEFAULT_PROFILE_ID);
        return;
      }
      for (const p of toOpen) {
        for (const saved of this.savedWindows(p.id)) {
          if (saved.open === true) this.create(p, { saved, content: "restore" });
        }
      }
      this.deps.onChange?.();
    } finally {
      this.restoringStartup = false;
    }
  }
  /** Mark that the app is quitting, so windows closing during shutdown keep their
   * "was open" flag (they should reopen next launch) instead of being recorded as
   * user-closed. Called from index.ts on the app 'before-quit' event. */
  beginQuit() {
    this.quitting = true;
  }
  /** Open a window for an existing profile id, or focus one if the profile already
   * has a window open. A profile may have several windows (a tear-off); this focuses
   * one and never opens a second. When none are open it creates one, restoring the
   * profile's primary saved window (its first entry) so the user lands where they
   * left off. */
  openProfile(id) {
    const existing = this.aWindowForProfile(id);
    if (existing && !existing.window.isDestroyed()) {
      if (existing.window.isMinimized()) existing.window.restore();
      existing.window.focus();
      this.menuFocusId = id;
      this.deps.onChange?.();
      return { id, created: false };
    }
    const profile = findById(this.profiles, id);
    if (!profile) throw new Error(`unknown profile: ${id}`);
    if (needsUnlock(profile, new Set(this.unlockedVaults.keys()))) {
      throw new Error(`profile is locked: unlock it first (unlock-profile)`);
    }
    const primary = this.savedWindows(id)[0];
    this.create(profile, primary ? { saved: primary, content: "restore" } : { content: "home" });
    this.deps.onChange?.();
    return { id, created: true };
  }
  /** Close the profile's window(s), exactly like a user close: each window's
   * 'close'/'closed' handlers snapshot geometry and do the bookkeeping, and the
   * profile auto-locks if it was an unlocked vault (once its LAST window is gone).
   * A profile may have several windows (a tear-off) — all are closed. Other
   * profiles' windows are untouched, and on macOS the app keeps running with no
   * window (window-all-closed does not quit). `closed` is false when the id is
   * known but not currently open. Throws on an unknown id. */
  closeProfile(id) {
    if (!findById(this.profiles, id)) throw new Error(`unknown profile: ${id}`);
    const windows = this.windowsForProfile(id);
    if (windows.length === 0) return { id, closed: false };
    for (const pw of windows) pw.window.close();
    return { id, closed: true };
  }
  /** Open an external URL (a link/file handed to Mira as the system default
   * browser) in a new tab. Targets the focused window, else the LAST focused
   * profile window, else any open one; if Mira was launched by the click and has
   * no window yet, opens the default profile first. The tab takes page focus (not
   * the address bar) — the user asked for this page, not to type one. */
  openUrl(url2, profileId) {
    const trimmed = url2.trim();
    if (!trimmed) return;
    let target;
    if (profileId) {
      this.openProfile(profileId);
      target = this.aWindowForProfile(profileId);
    } else {
      target = this.findByWindow(electron.BrowserWindow.getFocusedWindow()) ?? (this.menuFocusId ? this.aWindowForProfile(this.menuFocusId) : null) ?? this.openById.values().next().value ?? null;
    }
    if (!target || target.window.isDestroyed()) {
      this.openProfile(DEFAULT_PROFILE_ID);
      target = this.aWindowForProfile(DEFAULT_PROFILE_ID) ?? this.openById.values().next().value ?? null;
    }
    if (!target || target.window.isDestroyed()) return;
    this.newTabIn(target, trimmed, false);
    if (target.window.isMinimized()) target.window.restore();
    target.window.show();
    target.window.focus();
  }
  /** Create a new profile (fresh id + label), persist it, and open its window. */
  createProfile(label) {
    const profile = {
      id: crypto.randomUUID(),
      label: label ?? nextProfileLabel(this.profiles)
    };
    this.profiles = addProfile(this.profiles, profile);
    this.deps.persist(this.profiles);
    this.openProfile(profile.id);
    return { id: profile.id, label: profile.label };
  }
  /** Relabel an existing profile. The id (and its cookies) are untouched. */
  renameProfile(id, label) {
    this.profiles = renameProfile(this.profiles, id, label);
    this.deps.persist(this.profiles);
    const updated = findById(this.profiles, id);
    this.broadcastToProfile(id, "mira:profile-renamed", updated.label);
    this.deps.onChange?.();
    return { id: updated.id, label: updated.label };
  }
  /** The full theme a profile paints its chrome with (themeId → legacy color →
   * default), resolved against the live theme list. */
  resolveTheme(profile) {
    return resolveProfileTheme(profile.themeId, profile.color, this.themes);
  }
  /** Live-push a profile's resolved theme to every open window of it: the chrome
   * reads the theme once from the URL at load, so a change needs a push to
   * repaint. */
  pushProfileTheme(id) {
    const profile = findById(this.profiles, id);
    if (!profile) return;
    this.broadcastToProfile(id, "mira:profile-theme", this.resolveTheme(profile));
  }
  /** A ProfileInfo view of a profile (id + label + themeId/legacy color). */
  toProfileInfo(profile) {
    return {
      id: profile.id,
      label: profile.label,
      ...profile.themeId ? { themeId: profile.themeId } : {},
      ...profile.color ? { color: profile.color } : {}
    };
  }
  /** Set (a hex) or clear (null) a profile's LEGACY tint color, persist it, and
   * live-push the resolved theme. Kept for back-compat (set-profile-color); new
   * callers use setProfileTheme. */
  setProfileColor(id, color) {
    this.profiles = setProfileColor(this.profiles, id, color);
    this.deps.persist(this.profiles);
    this.pushProfileTheme(id);
    this.broadcastProfilesChanged();
    return this.toProfileInfo(findById(this.profiles, id));
  }
  /** Assign a theme to a profile (or clear with null → default), persist, and
   * live-push it to that profile's open windows. Throws on unknown profile or an
   * unknown theme id. */
  setProfileTheme(id, themeId) {
    if (themeId !== null && !findTheme(this.themes, themeId)) {
      throw new Error(`unknown theme: ${themeId}`);
    }
    this.profiles = setProfileTheme(this.profiles, id, themeId);
    this.deps.persist(this.profiles);
    this.pushProfileTheme(id);
    this.broadcastProfilesChanged();
    return this.toProfileInfo(findById(this.profiles, id));
  }
  listThemes() {
    return this.themes;
  }
  /** Create a custom theme, persist the custom set, return it. */
  createTheme(input) {
    const [themes, theme] = createTheme(this.themes, input);
    this.themes = themes;
    this.deps.persistThemes(customThemes(this.themes));
    this.broadcastProfilesChanged();
    return theme;
  }
  /** Update a custom theme, persist, and repaint every open window whose profile
   * currently resolves to it. */
  updateTheme(id, patch) {
    this.themes = updateTheme(this.themes, id, patch);
    this.deps.persistThemes(customThemes(this.themes));
    this.repaintProfilesUsingTheme(id);
    this.broadcastProfilesChanged();
    return findTheme(this.themes, id);
  }
  /** Delete a custom theme, persist, and repaint any window whose profile was on
   * it (it now falls back to the default theme). */
  deleteTheme(id) {
    const affected = this.profiles.filter((p) => p.themeId === id).map((p) => p.id);
    this.themes = deleteTheme(this.themes, id);
    this.deps.persistThemes(customThemes(this.themes));
    for (const pid of affected) this.pushProfileTheme(pid);
    this.broadcastProfilesChanged();
    return { id };
  }
  /** Repaint every open window whose profile resolves to theme `id`. */
  repaintProfilesUsingTheme(id) {
    for (const p of this.profiles) {
      if (this.resolveTheme(p).id === id) this.pushProfileTheme(p.id);
    }
  }
  /** Ping every open window's chrome that the profile set / labels changed, so an
   * open Settings tab refetches its list. The Settings surface now lives inside
   * each profile window (a tab), not a dedicated window, so the push must fan out
   * to all of them. Cheap: the chrome only refetches if it has a Settings tab. */
  broadcastProfilesChanged() {
    for (const pw of this.openById.values()) {
      if (!pw.window.isDestroyed()) pw.window.webContents.send("mira:profiles-changed");
    }
  }
  /** Create one window for a profile. `opts.saved` is the specific persisted
   * window to restore (its geometry + tabs) — a profile may have several, so the
   * caller picks which; without it the window starts on the home page. `opts.bounds`
   * forces the geometry (the detach path, which drops the new window at the tear-off
   * point). `opts.content` selects what fills the strip once extensions have loaded:
   * 'restore' the saved tabs, 'home' a fresh home tab, or 'empty' nothing (the detach
   * path attaches the torn-off tab itself). */
  create(profile, opts = {}) {
    const content = opts.content ?? (opts.saved ? "restore" : "home");
    const windowId = opts.saved?.windowId ?? crypto.randomUUID();
    const displays = electron.screen.getAllDisplays();
    const savedBounds = opts.bounds ?? opts.saved?.bounds;
    const bounds = boundsOnScreen(
      savedBounds,
      displays.map((d) => d.workArea)
    );
    const window = new electron.BrowserWindow({
      // Size is safe to pass to the constructor; POSITION is applied via setBounds
      // after creation (below): on macOS, constructor x/y is unreliable for placing
      // a window onto a secondary / external display, whereas setBounds honors the
      // global desktop coordinate space across displays.
      ...bounds ? { width: bounds.width, height: bounds.height } : { width: 1e3, height: 720 },
      show: false,
      autoHideMenuBar: true,
      // Frameless: no native title bar and no window buttons. The toolbar fills
      // the top strip (~28px reclaimed) and doubles as the drag handle
      // (-webkit-app-region: drag). close / minimize / fullscreen are driven by
      // the standard menu accelerators (Cmd+W / Cmd+M / Ctrl+Cmd+F, see menu.ts),
      // which are application-level and so keep working without a frame.
      frame: false,
      ...this.deps.icon ? { icon: this.deps.icon } : {},
      webPreferences: {
        preload: this.deps.preloadPath,
        sandbox: false,
        // The chrome gets its OWN session so profile extensions (loaded in the
        // default session for the default profile) can never inject content
        // scripts into Mira's UI (see chrome-session.ts).
        partition: CHROME_PARTITION
      }
    });
    if (bounds) {
      window.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
      if (bounds.fullScreen) {
        const target = displays.find((d) => d.id === bounds.displayId);
        const current = electron.screen.getDisplayMatching({
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height
        });
        if (target && target.id !== current.id) window.setBounds(target.workArea);
        window.setFullScreen(true);
      } else if (bounds.maximized) {
        const target = displays.find((d) => d.id === bounds.displayId) ?? electron.screen.getDisplayMatching({
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height
        });
        window.setBounds(target.workArea);
        window.maximize();
      }
      if (this.restoringStartup && !bounds.fullScreen && bounds.spaceIndex !== void 0) {
        this.applySavedSpace(window, bounds);
        window.once("show", () => this.applySavedSpace(window, bounds));
      }
    }
    let resolveReady;
    const ready = new Promise((resolve) => {
      resolveReady = resolve;
    });
    const profileWindow = {
      window,
      id: profile.id,
      windowId,
      ready,
      views: /* @__PURE__ */ new Map(),
      devtools: /* @__PURE__ */ new Map(),
      state: emptyTabState(),
      panelCollapsed: false,
      folders: [],
      chromeHidden: false,
      zenSnapshot: null,
      settingsTabId: null,
      closeArmedId: null,
      closedTabs: [],
      mru: emptyMru(),
      restoredLoadedIds: /* @__PURE__ */ new Set(),
      paletteOpen: false,
      mediaGalleryOpen: false,
      media: /* @__PURE__ */ new Map(),
      skillPane: closedSkillPane(),
      findText: "",
      pushTimer: null,
      layoutThrottled: false,
      layoutPending: false,
      tooltip: null,
      tooltipReady: Promise.resolve(),
      tooltipSeq: 0,
      toast: null,
      toastReady: Promise.resolve(),
      toastSeq: 0,
      toastTimer: null,
      htmlFullScreen: null,
      restored: false
    };
    this.openById.set(windowId, profileWindow);
    ensureTooltip(profileWindow);
    ensureToast(profileWindow);
    window.on("resize", () => {
      hideTooltip(profileWindow);
      this.scheduleLayout(profileWindow);
      this.saveSession(profileWindow);
    });
    window.on("moved", () => this.saveSession(profileWindow));
    window.on("ready-to-show", () => window.show());
    window.on("focus", () => {
      this.saveSession(profileWindow);
      if (this.menuFocusId === profileWindow.id) return;
      this.menuFocusId = profileWindow.id;
      this.deps.onChange?.();
    });
    window.on("close", () => this.saveSession(profileWindow));
    window.on("closed", () => {
      this.openById.delete(windowId);
      const othersRemain = this.windowsForProfile(profile.id).length > 0;
      if (this.quitting) ;
      else if (othersRemain) {
        this.removeSessionEntry(profileWindow);
        this.scheduleFlush();
      } else {
        this.saveSession(profileWindow, { open: false });
      }
      destroyTooltip(profileWindow);
      destroyToast(profileWindow);
      this.deps.onChange?.();
      if (!this.quitting && !this.lockingAll && !othersRemain && this.unlockedVaults.has(profile.id)) {
        this.lockProfileVault(profile.id).catch(
          (error) => console.error(`[mira] auto-lock of profile ${profile.id} failed`, error)
        );
      }
    });
    this.wireTabShortcuts(profileWindow, window.webContents);
    this.deps.loadRenderer(
      window,
      profile,
      this.effectivePartition(profile.id),
      this.resolveTheme(profile)
    );
    this.initExtensions(profileWindow).catch((error) => console.error("[mira] failed to load extensions", error)).then(() => {
      if (profileWindow.window.isDestroyed()) return;
      if (content === "restore" && opts.saved && opts.saved.tabs.length > 0) {
        this.restoreSession(profileWindow, opts.saved);
      } else if (content === "home") {
        this.newTabIn(profileWindow, this.appSettings.homeUrl);
      }
      profileWindow.restored = true;
    }).finally(() => resolveReady());
    return profileWindow;
  }
  /** The Electron session behind a profile id. The default profile uses the
   * default session explicitly — partitionForId returns undefined for it, and
   * fromPartition(String(undefined)) would silently create an in-memory
   * partition (see extensions-plan.md §4.1). */
  sessionFor(id) {
    const partition = this.effectivePartition(id);
    return partition ? electron.session.fromPartition(partition) : electron.session.defaultSession;
  }
  /** The partition STRING to use for a profile's session RIGHT NOW. For an unlocked
   * encrypted profile that is its per-unlock nonce partition (so every session/
   * cookie/extension lookup lands on the fresh session that holds the restored
   * data); otherwise the canonical partition (undefined for the default profile).
   * Every partition resolution for a profile must go through here — using the raw
   * partitionForId would bind to the stale canonical session and lose cookies. */
  effectivePartition(id) {
    return this.unlockedPartition.get(id) ?? partitionForId(id);
  }
  /** Create the extension system for this profile's session (idempotent) with
   * hooks that route chrome.tabs calls onto OUR tab strip, then load the
   * profile's installed extensions. Returns the loading promise so create() can
   * order the session restore after it. */
  initExtensions(pw) {
    const ses = this.sessionFor(pw.id);
    const profileId = pw.id;
    const live = () => this.aWindowForProfile(profileId);
    this.deps.extensions.ensureFor(ses, {
      createTab: async ({ url: url2 }) => {
        const target = live();
        if (!target) throw new Error("profile window is closed");
        const tab = this.newTabIn(target, url2 ?? this.appSettings.homeUrl);
        const view = target.views.get(tab.id);
        if (!view) throw new Error("tab failed to materialize");
        return [view.webContents, target.window];
      },
      selectTab: (wc) => {
        const target = live();
        const id = target ? this.tabIdForWebContents(target, wc) : null;
        if (target && id) this.selectTabIn(target, id);
      },
      removeTab: (wc) => {
        const target = live();
        const id = target ? this.tabIdForWebContents(target, wc) : null;
        if (target && id) this.closeTabIn(target, id);
      },
      activeTab: () => {
        const target = live();
        const id = target?.state.activeId;
        const view = target && id ? target.views.get(id) : void 0;
        return view ? view.webContents : null;
      },
      chromeWebContents: () => {
        const target = live();
        return target ? target.window.webContents : null;
      }
    });
    return this.deps.extensions.installWebStore(ses, profileId).then(() => this.deps.extensions.loadInstalled(ses, profileId));
  }
  /** The tab id owning `wc` in this window, or null (e.g. a popup's contents). */
  tabIdForWebContents(pw, wc) {
    for (const [id, view] of pw.views) {
      if (view.webContents === wc) return id;
    }
    return null;
  }
  /** Tell the extension system which tab is active now (chrome.tabs.onActivated
   * & friends). Called from every path that changes `state.activeId` — a tab
   * without a view (asleep / Settings) is simply not reported. */
  notifyExtensionsActiveTab(pw) {
    const id = pw.state.activeId;
    this.recordMruVisit(pw, id);
    if (!id || id === pw.settingsTabId) return;
    const view = pw.views.get(id);
    if (view) this.deps.extensions.selectTab(view.webContents);
  }
  /** Record `id` as the current MRU entry, unless a back/forward step is in flight
   * (mruSuppressRecord) or there is no active tab. Idempotent on the tab already at
   * the cursor, so the many notifyExtensionsActiveTab callers never create dups. */
  recordMruVisit(pw, id) {
    if (this.mruSuppressRecord || !id) return;
    pw.mru = mruRecord(pw.mru, id);
  }
  /** Step the recently-viewed-tabs history (Cmd+Alt+Left = back / -1,
   * Cmd+Alt+Right = forward / +1) and select the tab it lands on, without
   * recording that hop as a new visit. No-op at either end of the history. */
  stepMruIn(pw, direction) {
    const { mru, id } = mruStep(pw.mru, direction);
    if (id === null) return { id: null };
    pw.mru = mru;
    this.mruSuppressRecord = true;
    try {
      this.selectTabIn(pw, id);
    } finally {
      this.mruSuppressRecord = false;
    }
    return { id };
  }
  /** Give a tab (already in the state list) its live WebContentsView and start
   * loading its url. This is the lazy-load boundary: a tab exists in the strip
   * without a view until it is first selected. No-op if already materialized.
   * All tabs of a profile window share the profile's session partition. */
  materializeTab(pw, tab, httpReferrer) {
    if (pw.views.has(tab.id)) return;
    if (tab.id === pw.settingsTabId) return;
    const partition = this.effectivePartition(pw.id);
    this.ensurePermissionHandlers(partition, pw.id);
    this.ensureDownloadHandler(partition, pw.id);
    const view = new electron.WebContentsView({
      // nodeIntegrationInSubFrames: without it Electron runs preload scripts in
      // the MAIN frame only, and the extension service-worker bridge (the frame
      // preload registered in extensions.ts) exists precisely for chrome-extension://
      // iframes NESTED in web pages — Kondo's ext.html (extensions-plan.md §8.11).
      // Both session preloads (the lib's and ours) gate out of non-extension
      // frames immediately, so the per-iframe cost is negligible.
      // focusOnNavigation: false stops Chromium's default of grabbing focus every
      // time the page commits a navigation. Without it, a page that reloads itself
      // (dev-server HMR full reload, meta-refresh, JS redirect) drags the whole app
      // to the foreground on macOS even while Mira sits in the background — jumping
      // in front of the editor mid-coding. Electron ≥40/41 gates this per-view.
      webPreferences: {
        ...partition ? { partition } : {},
        nodeIntegrationInSubFrames: true,
        focusOnNavigation: false
      }
    });
    pw.window.contentView.addChildView(view);
    pw.views.set(tab.id, view);
    this.wireView(pw, tab.id, view.webContents);
    this.startMediaCaptureFor(pw, tab.id, view.webContents);
    this.deps.extensions.addTab(view.webContents, pw.window);
    this.wireTabShortcuts(pw, view.webContents);
    this.wireMagnifier(pw, tab.id, view.webContents);
    this.wireContextMenu(pw, view.webContents);
    view.webContents.setWindowOpenHandler((details) => {
      const decision = decideWindowOpen(details);
      const host = this.ownerOf(tab.id) ?? pw;
      if (decision.kind === "popup") {
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            parent: host.window,
            width: 520,
            height: 640,
            // Same flag as the tab views: extension iframes (password managers…)
            // nested in a popup page need frame preloads too.
            webPreferences: {
              ...partition ? { partition } : {},
              nodeIntegrationInSubFrames: true
            }
          }
        };
      }
      this.newTabIn(host, decision.url, false, tab.id, false, decision.referrer);
      return { action: "deny" };
    });
    if (tab.url && httpReferrer) {
      view.webContents.loadURL(tab.url, { httpReferrer });
    } else {
      view.webContents.loadURL(tab.url || this.blankPageUrl(pw));
    }
  }
  /** The URL a blank tab loads: Mira's home page as a fresh data: URL, baked with
   * this window's live session snapshot (profile, tab count, memory). Rebuilt on
   * demand so re-selecting a blank tab shows current numbers (see selectTabIn). */
  blankPageUrl(pw) {
    const total = pw.state.tabs.length;
    const mem = this.deps.getMemoryUsage();
    const profile = findById(this.profiles, pw.id);
    const stats = {
      profileLabel: profile?.label ?? "Mira",
      tabCount: total,
      loadedCount: pw.views.size,
      memoryText: formatMemory(mem),
      processCount: mem.processes,
      ...profile ? { theme: this.resolveTheme(profile) } : {}
    };
    return homePageUrl(stats);
  }
  /** Create a new tab in `pw`, load `url`, focus it, re-layout and persist.
   * `focusChrome` (the command path: click / Cmd+T) hands keyboard focus to the
   * address bar instead of the page — see focusAddressBar. */
  newTabIn(pw, url2, focusChrome = false, afterId, background = false, httpReferrer) {
    const prevActiveId = pw.state.activeId;
    const tab = { id: crypto.randomUUID(), title: "", url: url2, favicon: null };
    pw.state = background ? addTabInactive(pw.state, tab) : afterId ? addTabAfter(pw.state, tab, afterId) : addTabAtHead(pw.state, tab);
    pw.closeArmedId = null;
    this.materializeTab(pw, tab, httpReferrer);
    if (!background) {
      this.notifyExtensionsActiveTab(pw);
    } else if (prevActiveId && pw.state.activeId !== prevActiveId) {
      this.selectTabIn(pw, prevActiveId);
    }
    this.layout(pw);
    this.pushTabs(pw);
    this.saveSession(pw);
    if (focusChrome && !background) {
      const view = pw.views.get(tab.id);
      view?.webContents.once("focus", () => {
        if (!pw.window.isDestroyed()) pw.window.webContents.focus();
      });
      this.focusAddressBar(pw);
    }
    return tab;
  }
  /** Open the internal Settings tab in `pw`, or select it if already open (one per
   * window). The tab carries no WebContentsView — layout() hides the web views
   * while it is active and the chrome renders <Settings/> in the body. Returns the
   * tab id. Not focus-chrome: the settings panel is the chrome, so focus stays put.
   * The requested sub-section travels in the tab url (mira://settings/<section>);
   * the chrome derives which panel tab to show from it. */
  openSettingsTabIn(pw, section) {
    const url2 = section ? `${SETTINGS_URL}/${section}` : SETTINGS_URL;
    if (pw.settingsTabId && pw.state.tabs.some((t) => t.id === pw.settingsTabId)) {
      if (section) {
        pw.state = updateTab(pw.state, pw.settingsTabId, { url: url2 });
      }
      return this.selectTabIn(pw, pw.settingsTabId);
    }
    const tab = { id: crypto.randomUUID(), title: "Settings", url: url2, favicon: null };
    pw.state = addTabAtHead(pw.state, tab);
    pw.closeArmedId = null;
    pw.settingsTabId = tab.id;
    this.layout(pw);
    this.pushTabs(pw);
    this.saveSession(pw);
    return { id: tab.id };
  }
  /** Recreate a profile window's saved tabs and restore its active tab + panel.
   * The tabs enter the strip unloaded (metadata only); only the active tab gets
   * its WebContentsView now — the rest materialize when first selected. */
  restoreSession(pw, saved) {
    for (const t of saved.tabs) {
      const id = crypto.randomUUID();
      pw.state = addTab(pw.state, {
        id,
        title: t.title,
        url: t.url,
        favicon: t.favicon,
        // Saved order already has the pinned block at the head of the strip.
        ...t.pinned === true ? { pinned: true } : {},
        // Folder membership rides on the tab (ids are new, but folderId is stable).
        ...t.folderId ? { folderId: t.folderId } : {},
        // Keep-awake is durable tab state: it comes back set so the tab is woken
        // below and stays immune to discard.
        ...t.keepAwake === true ? { keepAwake: true } : {}
      });
      if (t.loaded === true) pw.restoredLoadedIds.add(id);
    }
    pw.folders = saved.folders ?? [];
    pw.state = pruneFolderMembership(pw.state, pw.folders);
    const activeTab = pw.state.tabs[saved.activeIndex];
    if (activeTab) {
      pw.state = selectTab(pw.state, activeTab.id);
      this.materializeTab(pw, activeTab);
      this.notifyExtensionsActiveTab(pw);
    }
    for (const tab of pw.state.tabs) {
      if (tab.keepAwake === true) this.materializeTab(pw, tab);
    }
    pw.panelCollapsed = saved.panelCollapsed;
    this.layout(pw);
    this.pushTabs(pw);
  }
  /** Snapshot this window's tab strip + geometry into the in-memory sessions map
   * immediately, and schedule a debounced disk write. The snapshot is cheap and
   * always current; the write is what we coalesce, so a burst of page events is
   * one write, not one per event (persistSessions was a synchronous writeFile on
   * the main thread — see index.ts). */
  saveSession(pw, opts) {
    const persistable = pw.settingsTabId ? {
      tabs: pw.state.tabs.filter((t) => t.id !== pw.settingsTabId),
      activeId: pw.state.activeId
    } : pw.state;
    const open = opts?.open ?? true;
    if (!pw.restored) {
      const prev = this.savedEntry(pw);
      if (prev) {
        const bounds = this.currentBounds(pw);
        this.upsertSession(pw, { ...prev, ...bounds ? { bounds } : {}, open });
        this.scheduleFlush();
      }
      return;
    }
    this.upsertSession(
      pw,
      toPersisted(
        persistable,
        pw.panelCollapsed,
        this.currentBounds(pw),
        open,
        pw.folders,
        // The awake set = tabs with a live view. Settings never has a view, and it
        // was already filtered out of `persistable` above.
        new Set(pw.views.keys()),
        pw.windowId
      )
    );
    this.scheduleFlush();
  }
  /** Arm the debounced flush of sessions.json. A pending timer already covers the
   * latest snapshot (which saveSession refreshed in place), so we don't reset it. */
  scheduleFlush() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.deps.persistSessions(this.sessions);
    }, ProfileManager.SAVE_DEBOUNCE_MS);
  }
  /** Cancel any pending debounced flush and write the current snapshot now. Called
   * on app quit (see index.ts) so the last few hundred ms of changes always land,
   * even if the debounce timer had not fired yet. */
  flushPendingSaves() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.deps.persistSessions(this.sessions);
    for (const data of this.dataById.values()) data.flush();
  }
  /** Install the web-permission handlers on a profile's session, once per
   * partition. Electron does NOT show Chromium's native "Allow?" bubble: a page's
   * request is routed here instead, and if unhandled the CHECK denies by default —
   * which is why geolocation (Google Maps) silently failed. Policy: grant all (see
   * permissions.ts), and record every grant per origin so Settings can list it.
   * Both handlers exist because most web APIs consult the synchronous CHECK first
   * and only raise a REQUEST if it denies (electron.d.ts). */
  ensurePermissionHandlers(partition, profileId) {
    const key = partition ?? "";
    if (this.permissionSessions.has(key)) return;
    this.permissionSessions.add(key);
    const ses = partition ? electron.session.fromPartition(partition) : electron.session.defaultSession;
    this.mediaPicker ??= new MediaDevicePickerService(electron.app.getPath("userData"));
    this.mediaPicker.attach(ses);
    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
      const granted = shouldGrantPermission();
      this.dataFor(profileId).recordGrant(requestingOrigin, permission);
      this.maybeHandleLocation(permission);
      return granted;
    });
    ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
      const granted = shouldGrantPermission();
      this.dataFor(profileId).recordGrant(originOf(details.requestingUrl), permission);
      this.maybeHandleLocation(permission);
      callback(granted);
    });
  }
  /** Hook a profile's session for file downloads, once per partition. Chromium
   * routes a page-triggered file save here; we set its path to ~/Downloads (so no
   * OS save dialog appears — Mickael always saves there) and mirror the DownloadItem
   * into the tracker, pushing progress to the chrome and a toast on completion.
   * partition ↔ profile id is 1:1, so the captured profileId routes the toast. */
  ensureDownloadHandler(partition, profileId) {
    const key = partition ?? "";
    if (this.downloadSessions.has(key)) return;
    this.downloadSessions.add(key);
    const ses = partition ? electron.session.fromPartition(partition) : electron.session.defaultSession;
    ses.on("will-download", (_event, item) => this.trackDownload(item, profileId));
  }
  /** Take over one DownloadItem: pick a non-colliding path under ~/Downloads (which
   * also suppresses the save dialog), register a record, and forward Electron's
   * updated/done events into the tracker — broadcasting changes to the profile's
   * chrome and flashing a toast when the file lands. */
  trackDownload(item, profileId) {
    const dir = electron.app.getPath("downloads");
    const suggested = item.getFilename();
    let name = suggested;
    for (let i = 1; node_fs.existsSync(node_path.join(dir, name)); i++) name = numberedFilename(suggested, i);
    const savePath = node_path.join(dir, name);
    item.setSavePath(savePath);
    const id = crypto.randomUUID();
    const startedAt = Date.now();
    this.downloadItems.set(id, item);
    this.downloadTracker.add({
      id,
      url: item.getURL(),
      filename: name,
      savePath,
      state: "progressing",
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      paused: item.isPaused(),
      startedAt,
      updatedAt: startedAt,
      profileId
    });
    this.broadcastToProfile(profileId, "mira:downloads-changed");
    item.on("updated", (_e, state) => {
      this.downloadTracker.update(
        id,
        {
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes(),
          paused: item.isPaused(),
          state: state === "interrupted" ? "interrupted" : "progressing"
        },
        Date.now()
      );
      this.broadcastToProfile(profileId, "mira:downloads-changed");
    });
    item.once("done", (_e, state) => {
      const finalState = state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "interrupted";
      const record = this.downloadTracker.update(
        id,
        { state: finalState, receivedBytes: item.getReceivedBytes(), paused: false },
        Date.now()
      );
      this.downloadItems.delete(id);
      this.broadcastToProfile(profileId, "mira:downloads-changed");
      if (record) {
        const host = this.aWindowForProfile(profileId);
        if (host) void showToast(host, completionMessage(record));
      }
    });
  }
  /** React to a geolocation permission request from the REAL macOS authorization
   * status (read via the native addon): fire the native prompt when undetermined,
   * open Settings when genuinely denied, and — crucially — do NOTHING when it's
   * already authorized. The pure branch logic is decideLocationAction; the flags
   * keep prompt/Settings to once per run. */
  maybeHandleLocation(permission) {
    const action = decideLocationAction(
      permission,
      process.platform,
      locationAuthStatus(),
      this.locationSettingsOpened
    );
    if (action === "prompt") {
      if (this.locationPromptRequested) return;
      this.locationPromptRequested = true;
      requestLocationAuthorization();
    } else if (action === "open-settings") {
      this.locationSettingsOpened = true;
      this.openLocationSettings();
    }
  }
  /** Open the system Location Services pane. Returns whether there was one to open
   * (only macOS gates a granted geolocation behind an OS tick). Reached both from
   * maybeNudgeLocation and from the `open-location-settings` command on the bus. */
  openLocationSettings() {
    const url2 = locationSettingsUrl(process.platform);
    if (!url2) return { opened: false };
    electron.shell.openExternal(url2).catch((error) => console.error("[mira] open location settings", error));
    return { opened: true };
  }
  /** Put a restored window back on the virtual desktop it was saved on: resolve
   * the persisted index ("2nd desktop of display X") against the LIVE Spaces
   * layout, then ask the window server to move the window there. Every step
   * degrades to a no-op (no addon, display gone, desktop removed, already on
   * the target desktop), so this is safe to call twice. */
  applySavedSpace(window, bounds) {
    if (bounds.spaceIndex === void 0) return;
    const wid = parseWindowNumber(window.getMediaSourceId());
    if (wid === void 0) return;
    const target = resolveTargetSpaceId(spacesLayout(), bounds.displayId, bounds.spaceIndex);
    if (target === void 0) return;
    moveWindowToSpace(wid, target);
  }
  /** The window's live geometry, or its last saved geometry once it is destroyed
   * (the 'closed' path can no longer read the native window). Uses getNormalBounds
   * so a maximized/fullscreen window still records the rectangle to restore to. */
  currentBounds(pw) {
    if (pw.window.isDestroyed()) return this.savedEntry(pw)?.bounds;
    const b = pw.window.getNormalBounds();
    const display = electron.screen.getDisplayMatching(pw.window.getBounds());
    const wid = parseWindowNumber(pw.window.getMediaSourceId());
    const location = wid === void 0 ? void 0 : windowSpaceLocation(spacesLayout(), windowSpaces(wid));
    const spaceIndex = location?.spaceIndex ?? this.savedEntry(pw)?.bounds?.spaceIndex;
    return {
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      maximized: pw.window.isMaximized(),
      fullScreen: pw.window.isFullScreen(),
      displayId: display.id,
      ...spaceIndex !== void 0 ? { spaceIndex } : {}
    };
  }
  /** Mirror a tab's live page state (title / url / favicon) into its metadata and
   * push the refreshed strip to the chrome. */
  wireView(initialPw, tabId, wc) {
    const owner = () => this.ownerOf(tabId) ?? initialPw;
    const patch = (p) => {
      const pw = owner();
      pw.state = updateTab(pw.state, tabId, p);
      this.schedulePush(pw);
      this.saveSession(pw);
      if ("url" in p || "title" in p) {
        const t = pw.state.tabs.find((x) => x.id === tabId);
        if (t) this.dataFor(pw.id).recordVisit(t.url, t.title);
      }
    };
    let failedUrl = "";
    const mirrorUrl = (navUrl) => isMiraHomeUrl(navUrl) ? "" : isMiraErrorUrl(navUrl) ? failedUrl : navUrl;
    wc.on("page-title-updated", (_e, title) => patch({ title }));
    wc.on("did-navigate", (_e, navUrl) => patch({ url: mirrorUrl(navUrl) }));
    wc.on("did-fail-load", (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      failedUrl = validatedURL;
      const errProfile = findById(this.profiles, owner().id);
      wc.loadURL(
        errorPageUrl({
          url: validatedURL,
          errorCode,
          errorDescription,
          ...errProfile ? { theme: this.resolveTheme(errProfile) } : {}
        })
      );
    });
    wc.on("did-navigate-in-page", (_e, navUrl, isMainFrame) => {
      if (isMainFrame) patch({ url: mirrorUrl(navUrl) });
    });
    wc.on("page-favicon-updated", (_e, favicons) => patch({ favicon: favicons?.[0] ?? null }));
    wc.on("audio-state-changed", () => this.schedulePush(owner()));
    let hover = EMPTY_HOVER;
    const pushHover = (ev) => {
      hover = reduceHover(hover, ev);
      const pw = owner();
      if (!pw.window.isDestroyed()) pw.window.webContents.send("mira:hover-url", hoverText(hover));
    };
    wc.on("update-target-url", (_e, url2) => pushHover({ type: "target", url: url2 }));
    installHoverReporter(wc, (active) => pushHover({ type: "js", active }));
    wc.on("found-in-page", (_e, result) => {
      const pw = owner();
      if (!result.finalUpdate || pw.window.isDestroyed()) return;
      pw.window.webContents.send("mira:find-result", {
        matches: result.matches,
        activeMatchOrdinal: result.activeMatchOrdinal
      });
    });
    wc.on("enter-html-full-screen", () => this.enterHtmlFullScreenIn(owner(), tabId));
    wc.on("leave-html-full-screen", () => this.leaveHtmlFullScreenIn(owner()));
    wc.on("destroyed", () => {
      const pw = owner();
      if (pw.htmlFullScreen?.tabId === tabId) this.leaveHtmlFullScreenIn(pw);
    });
  }
  /** The active tab's page entered HTML fullscreen: snapshot the panels, hide
   * them, and arm the episode (layout() then gives this tab the whole window).
   * The panels are hidden through the normal toggle paths so the chrome
   * re-renders — but BEFORE arming, so the forced hide is not recorded as a
   * user toggle (only toggles made during the episode overwrite the snapshot). */
  enterHtmlFullScreenIn(pw, tabId) {
    if (pw.htmlFullScreen || pw.state.activeId !== tabId) return;
    const snapshot = { tabsCollapsed: pw.panelCollapsed, skillPaneOpen: pw.skillPane.open };
    this.toggleTabsPanelIn(pw, true);
    this.setSkillPaneIn(pw, { ...pw.skillPane, open: false });
    pw.htmlFullScreen = enterFullScreen(tabId, snapshot);
    this.layout(pw);
  }
  /** HTML fullscreen ended: put the panels back — to their pre-fullscreen state,
   * or to whatever the user toggled them to during the episode (last change
   * wins). Idempotent: a no-op when no episode is live. */
  leaveHtmlFullScreenIn(pw) {
    if (!pw.htmlFullScreen) return;
    const restore = exitFullScreen(pw.htmlFullScreen);
    pw.htmlFullScreen = null;
    this.toggleTabsPanelIn(pw, restore.tabsCollapsed);
    this.setSkillPaneIn(pw, { ...pw.skillPane, open: restore.skillPaneOpen });
  }
  /** Position the active view below the toolbar, offset right by the tab panel
   * when it is shown, and hide every inactive view. */
  layout(pw) {
    if (pw.window.isDestroyed()) return;
    const { width, height } = pw.window.getContentBounds();
    const x = pw.panelCollapsed ? 0 : this.appSettings.sidebarWidth;
    const topChrome = pw.chromeHidden ? 0 : this.deps.toolbarHeight;
    const verticalChrome = pw.chromeHidden ? 0 : this.deps.toolbarHeight + this.deps.statusBarHeight;
    const paneRight = pw.skillPane.open ? this.appSettings.skillPaneWidth : 0;
    const bounds = {
      x,
      y: topChrome,
      width: Math.max(0, width - x - paneRight),
      height: Math.max(0, height - verticalChrome)
    };
    const panelsHidden = pw.panelCollapsed && !pw.skillPane.open;
    const fullScreenTabId = panelsHidden ? pw.htmlFullScreen?.tabId ?? null : null;
    for (const [id, view] of pw.views) {
      const active = id === pw.state.activeId && !pw.paletteOpen && !pw.mediaGalleryOpen;
      view.setVisible(active);
      if (active && id === fullScreenTabId) {
        view.setBounds({ x: 0, y: 0, width, height });
        pw.devtools.get(id)?.setVisible(false);
        continue;
      }
      const devtools = pw.devtools.get(id);
      if (active && devtools) {
        const split = dockRight(bounds);
        view.setBounds(split.page);
        devtools.setBounds(split.devtools);
        devtools.setVisible(true);
      } else {
        if (active) view.setBounds(bounds);
        devtools?.setVisible(false);
      }
    }
  }
  /** Open / close / toggle the command palette overlay in `pw`. Hides the active
   * view (via layout) so the chrome overlay is visible, focuses the chrome so it
   * receives keystrokes (the page held focus), and tells the chrome to render or
   * dismiss the overlay. Idempotent — re-asserting the same state is a no-op push. */
  setPaletteOpenIn(pw, open, mode = "launcher", query = "") {
    const next = open ?? !pw.paletteOpen;
    pw.paletteOpen = next;
    this.layout(pw);
    if (!pw.window.isDestroyed()) {
      if (next) pw.window.webContents.focus();
      pw.window.webContents.send("mira:toggle-palette", { open: next, mode, query });
    }
    return { open: next };
  }
  /** Set the skill pane state in `pw`: store it, re-layout (shrinks the web view's
   * width when open, restores it when closed), and push the state to the chrome so
   * it renders / hides the pane. The single path for both showSkillPane and close. */
  setSkillPaneIn(pw, state) {
    const opening = state.open && !pw.skillPane.open;
    pw.skillPane = state;
    if (pw.htmlFullScreen) {
      pw.htmlFullScreen = panelChanged(pw.htmlFullScreen, { skillPaneOpen: state.open });
    }
    this.layout(pw);
    if (!pw.window.isDestroyed()) {
      if (opening) pw.window.webContents.focus();
      pw.window.webContents.send("mira:skill-pane", state);
    }
  }
  /** Apply a panel-width change: relayout every open window (widths are app-wide)
   * so the web views follow the drag at once, and persist the settings debounced
   * so a drag doesn't hammer the disk. */
  applyPanelWidths() {
    for (const pw of this.openById.values()) this.layout(pw);
    if (this.settingsSaveTimer) clearTimeout(this.settingsSaveTimer);
    this.settingsSaveTimer = setTimeout(() => {
      this.settingsSaveTimer = null;
      this.deps.persistSettings(this.appSettings);
    }, 300);
  }
  /** Move keyboard focus from the (possibly just-created) web view back to the
   * chrome and ask it to focus the address bar. Needed because the active tab's
   * WebContentsView is a separate webContents that can hold focus. */
  focusAddressBar(pw) {
    if (pw.window.isDestroyed()) return;
    pw.window.webContents.focus();
    pw.window.webContents.send("mira:focus-address-bar");
  }
  /** The tab strip augmented with each tab's lazy-load state (loaded vs asleep),
   * which lives natively — whether a WebContentsView exists — not in the metadata
   * (see materializeTab). The active tab is always loaded. */
  tabInfos(pw) {
    return pw.state.tabs.map((t) => ({
      ...t,
      loaded: pw.views.has(t.id),
      kind: t.id === pw.settingsTabId ? "settings" : "web",
      pinned: t.pinned === true,
      keepAwake: t.keepAwake === true,
      folderId: t.folderId ?? null,
      // Live audio state read straight from the native view (like `loaded` from
      // pw.views): true while the page emits sound. An asleep tab has no view, so
      // it is never audible. Refreshed by the audio-state-changed push (wireView).
      audible: pw.views.get(t.id)?.webContents.isCurrentlyAudible() === true
    }));
  }
  /** Push the current tab strip (tabs, active id, panel state) to the chrome so
   * the sidebar re-renders. The renderer holds no tab state of its own. User
   * actions call this directly for immediacy; it also cancels any pending
   * debounced push (schedulePush) since it already sends the freshest state. */
  pushTabs(pw) {
    if (pw.pushTimer) {
      clearTimeout(pw.pushTimer);
      pw.pushTimer = null;
    }
    if (pw.window.isDestroyed()) return;
    pw.window.webContents.send("mira:tabs-changed", {
      tabs: this.tabInfos(pw),
      activeId: pw.state.activeId,
      panelCollapsed: pw.panelCollapsed,
      // Zen mode rides the tabs channel (like panelCollapsed): both are chrome
      // layout bits, so the renderer learns to hide/show the bars for free.
      chromeHidden: pw.chromeHidden,
      // Folder metadata rides the same channel so the sidebar groups tabs by
      // folder and reflects collapse/rename without a separate poll.
      folders: pw.folders
    });
  }
  /** Debounced strip push for the page-event path (title / favicon / in-page
   * nav), which fires in bursts. Live title/favicon updates in the sidebar land a
   * frame or two later, coalesced, instead of one IPC + re-render per event. */
  schedulePush(pw) {
    if (pw.pushTimer) return;
    pw.pushTimer = setTimeout(() => {
      pw.pushTimer = null;
      this.pushTabs(pw);
    }, ProfileManager.PUSH_DEBOUNCE_MS);
  }
  /** Throttle resize-driven layout to ~1 frame. Runs immediately on the leading
   * edge (the view stays glued to the window with no lag), then coalesces further
   * resize events into a single trailing run — so a drag-resize flood doesn't call
   * the native setBounds dozens of times per frame. */
  scheduleLayout(pw) {
    if (pw.layoutThrottled) {
      pw.layoutPending = true;
      return;
    }
    this.layout(pw);
    pw.layoutThrottled = true;
    setTimeout(() => {
      pw.layoutThrottled = false;
      if (pw.layoutPending) {
        pw.layoutPending = false;
        this.scheduleLayout(pw);
      }
    }, ProfileManager.LAYOUT_THROTTLE_MS);
  }
  closeTabIn(pw, id) {
    const index = pw.state.tabs.findIndex((t) => t.id === id);
    if (index === -1) throw new Error(`unknown tab: ${id}`);
    if (id !== pw.settingsTabId) {
      const closing = pw.state.tabs[index];
      pw.closedTabs.push({
        url: closing.url,
        title: closing.title,
        favicon: closing.favicon,
        pinned: closing.pinned === true,
        keepAwake: closing.keepAwake === true,
        index
      });
      if (pw.closedTabs.length > CLOSED_TAB_STACK_LIMIT) pw.closedTabs.shift();
    }
    const wasActive = pw.state.activeId === id;
    pw.state = closeTab(pw.state, id);
    pw.mru = mruPrune(pw.mru, id);
    if (pw.closeArmedId === id) pw.closeArmedId = null;
    if (id === pw.settingsTabId) pw.settingsTabId = null;
    const view = pw.views.get(id);
    if (view) {
      this.destroyDevToolsView(pw, id);
      pw.views.delete(id);
      this.deps.extensions.removeTab(view.webContents);
      pw.window.contentView.removeChildView(view);
      view.webContents.close();
    }
    if (wasActive && pw.state.activeId) {
      const next = pw.state.tabs.find((t) => t.id === pw.state.activeId);
      if (next) this.materializeTab(pw, next);
      this.notifyExtensionsActiveTab(pw);
    }
    if (pw.state.tabs.length === 0) {
      if (this.windowsForProfile(pw.id).length > 1) {
        pw.window.close();
        return { closed: true };
      }
      pw.panelCollapsed = false;
    }
    pw.state = pruneFolderMembership(pw.state, pw.folders);
    this.layout(pw);
    this.pushTabs(pw);
    this.saveSession(pw);
    return { closed: true };
  }
  /** Reopen the most recently closed tab (Cmd+Shift+T): pop the window's closed
   * stack, recreate the tab at its former position and pinned state, load its url
   * and focus it. A no-op (reopened:false) when nothing was closed. */
  reopenClosedTabIn(pw) {
    const closed = pw.closedTabs.pop();
    if (!closed) return { reopened: false, id: null };
    const tab = {
      id: crypto.randomUUID(),
      title: closed.title,
      url: closed.url,
      favicon: closed.favicon
    };
    pw.state = addTab(pw.state, tab);
    if (closed.pinned) pw.state = pinTab(pw.state, tab.id);
    if (closed.keepAwake) pw.state = setKeepAwake(pw.state, tab.id, true);
    pw.state = moveTab(pw.state, tab.id, closed.index);
    pw.closeArmedId = null;
    this.materializeTab(pw, tab);
    this.notifyExtensionsActiveTab(pw);
    this.layout(pw);
    this.pushTabs(pw);
    this.saveSession(pw);
    return { reopened: true, id: tab.id, url: tab.url };
  }
  /** Close the active tab (Cmd+W). A pinned tab must be pressed twice in a
   * row: the first Cmd+W only arms it (armed:true, nothing closes — its square
   * has no close button, this guards against a reflex Cmd+W), the second
   * consecutive one closes it. Switching tabs in between disarms. Returns the
   * id closed (or armed), or null if the window is empty. */
  closeActiveTabIn(pw) {
    const decision = closeActiveDecision(pw.state, pw.closeArmedId);
    if (decision.action === "none") return { closed: false, id: null };
    if (decision.action === "arm") {
      pw.closeArmedId = decision.id;
      return { closed: false, id: decision.id, armed: true };
    }
    this.closeTabIn(pw, decision.id);
    return { closed: true, id: decision.id };
  }
  /** Duplicate the active web tab: open a copy right under it, loading the live
   * page url, and focus it. No-op (id:null) when nothing is active or the active
   * tab is the internal Settings tab (it carries no web view). */
  duplicateActiveTabIn(pw) {
    const activeId = pw.state.activeId;
    if (!activeId || activeId === pw.settingsTabId) return { duplicated: false, id: null };
    const source = pw.state.tabs.find((t) => t.id === activeId);
    if (!source) return { duplicated: false, id: null };
    const view = pw.views.get(activeId);
    const url2 = view?.webContents.getURL() || source.url;
    const tab = this.newTabIn(pw, url2, false, activeId);
    return { duplicated: true, id: tab.id, url: url2 };
  }
  /** Tear down a tab's WebContentsView (freeing its renderer process) while
   * leaving the tab in the strip — the discard primitive. No-op if the tab is
   * already asleep. Does not touch the active tab or re-layout; callers do. */
  discardView(pw, id) {
    const view = pw.views.get(id);
    if (!view) return;
    this.destroyDevToolsView(pw, id);
    pw.views.delete(id);
    pw.media.delete(id);
    this.deps.extensions.removeTab(view.webContents);
    pw.window.contentView.removeChildView(view);
    view.webContents.close();
  }
  // --- Detach / re-attach a tab across windows ---
  // A tab can be torn off into its own window (or dropped onto another window of
  // the same profile) WITHOUT reloading its page: its live WebContentsView is
  // reparented from one window's contentView to another's, and its once-wired
  // event handlers follow it via ownerOf/ownerByWebContents (they resolve the
  // owning window at event time). Only same-profile windows can receive a tab —
  // the view is bound to the profile's session partition.
  /** Move a tab out of `source` and into a window at screen `point`: onto an
   * existing same-profile window whose frame contains the point (a re-attach), or
   * into a fresh window created there (a tear-off). Without a point, always a fresh
   * window. Returns the target windowId and whether it was new. A no-op (returns the
   * source) when the tab is the source's only tab and there is no other window to
   * land on — a "new window" would be identical to the current one. */
  async detachTabTo(source, tabId, point) {
    const tab = source.state.tabs.find((t) => t.id === tabId);
    if (!tab) throw new Error(`unknown tab: ${tabId}`);
    if (tabId === source.settingsTabId) throw new Error("cannot detach the Settings tab");
    let target = null;
    if (point) {
      for (const pw of this.windowsForProfile(source.id)) {
        if (pw === source) continue;
        const b = pw.window.getBounds();
        if (point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height) {
          target = pw;
          break;
        }
      }
    }
    let created = false;
    if (!target) {
      if (source.state.tabs.length <= 1) {
        return { windowId: source.windowId, created: false };
      }
      const profile = findById(this.profiles, source.id);
      if (!profile) throw new Error(`unknown profile: ${source.id}`);
      target = this.create(profile, { bounds: this.detachBounds(source, point), content: "empty" });
      created = true;
      await target.ready;
      if (target.window.isDestroyed()) throw new Error("detach target window was closed");
    }
    const insertion = !created && point ? await this.hitTestTabDrop(target, point) : void 0;
    this.attachTab(source, target, tabId, insertion);
    if (!target.window.isDestroyed()) {
      if (target.window.isMinimized()) target.window.restore();
      target.window.show();
      target.window.focus();
    }
    return { windowId: target.windowId, created };
  }
  /** Ask a window's chrome which tab row a screen point falls on, so a cross-window
   * re-attach can insert the dropped tab there. Runs in the target renderer (it
   * alone knows its row geometry), converting the screen point to client coords via
   * window.screenX/Y. Returns the row under the point and whether the point is in its
   * top or bottom half (before/after), or null when below the last row (append) or on
   * any failure. Only the vertical `.tab-row`s are tested — a dropped tab becomes a
   * regular row, never a pinned square. */
  async hitTestTabDrop(pw, point) {
    if (pw.window.isDestroyed()) return void 0;
    const script = `(() => {
      const y = ${point.y} - window.screenY;
      const rows = Array.from(document.querySelectorAll('.tab-row[data-tab-id]'));
      for (const el of rows) {
        const r = el.getBoundingClientRect();
        if (y < r.top) continue;
        if (y < r.top + r.height / 2) return { overTabId: el.getAttribute('data-tab-id'), pos: 'before' };
        if (y <= r.bottom) return { overTabId: el.getAttribute('data-tab-id'), pos: 'after' };
      }
      return null;
    })()`;
    try {
      const hit = await pw.window.webContents.executeJavaScript(script, true);
      return hit && typeof hit.overTabId === "string" ? hit : void 0;
    } catch {
      return void 0;
    }
  }
  /** The geometry for a torn-off window: the source window's current size, dropped
   * so its top strip sits at the tear-off point (Chrome-style), or offset from the
   * source when no point is known. */
  detachBounds(source, point) {
    const size = source.window.isDestroyed() ? { width: 1e3, height: 720 } : source.window.getNormalBounds();
    const width = size.width;
    const height = size.height;
    if (point) {
      return {
        x: Math.round(point.x - 120),
        y: Math.round(point.y - 8),
        width,
        height,
        maximized: false,
        fullScreen: false
      };
    }
    const b = source.window.isDestroyed() ? { x: 80, y: 80 } : source.window.getBounds();
    return { x: b.x + 40, y: b.y + 40, width, height, maximized: false, fullScreen: false };
  }
  /** Move tab `tabId` from `src` to `dst` (both windows of the same profile),
   * carrying its live view (no reload) when it has one. Reworks both strips, both
   * layouts, both saves. Closes `src` if it is left empty. `insertion` (from a drop
   * hit-test on `dst`) places the tab exactly where it was dropped — the tab it
   * landed on and which side; without it the tab joins the end of the strip. */
  attachTab(src, dst, tabId, insertion) {
    if (src === dst) return;
    const tab = src.state.tabs.find((t) => t.id === tabId);
    if (!tab) throw new Error(`unknown tab: ${tabId}`);
    if (src.htmlFullScreen?.tabId === tabId) this.leaveHtmlFullScreenIn(src);
    this.destroyDevToolsView(src, tabId);
    const view = src.views.get(tabId);
    const buffer = src.media.get(tabId);
    const wasPinned = tab.pinned === true;
    const wasLoaded = src.restoredLoadedIds.has(tabId);
    src.state = closeTab(src.state, tabId);
    src.mru = mruPrune(src.mru, tabId);
    if (src.closeArmedId === tabId) src.closeArmedId = null;
    src.views.delete(tabId);
    src.media.delete(tabId);
    src.restoredLoadedIds.delete(tabId);
    src.state = pruneFolderMembership(src.state, src.folders);
    if (view) {
      src.window.contentView.removeChildView(view);
      dst.window.contentView.addChildView(view);
      dst.views.set(tabId, view);
      this.deps.extensions.removeTab(view.webContents);
      this.deps.extensions.addTab(view.webContents, dst.window);
    }
    if (buffer) dst.media.set(tabId, buffer);
    if (wasLoaded) dst.restoredLoadedIds.add(tabId);
    const moved = { id: tabId, title: tab.title, url: tab.url, favicon: tab.favicon };
    dst.state = addTab(dst.state, moved);
    if (wasPinned) dst.state = pinTab(dst.state, tabId);
    if (insertion && !wasPinned) {
      const over = dst.state.tabs.find((t) => t.id === insertion.overTabId);
      if (over && over.id !== tabId) {
        dst.state = updateTab(dst.state, tabId, { folderId: over.folderId });
        const from = dst.state.tabs.findIndex((t) => t.id === tabId);
        const overIndex = dst.state.tabs.findIndex((t) => t.id === insertion.overTabId);
        const insertBefore = insertion.pos === "before" ? overIndex : overIndex + 1;
        dst.state = moveTab(
          dst.state,
          tabId,
          from < insertBefore ? insertBefore - 1 : insertBefore
        );
      }
    }
    dst.closeArmedId = null;
    if (src.state.tabs.length === 0) {
      src.window.close();
    } else {
      const nextActive = src.state.tabs.find((t) => t.id === src.state.activeId);
      if (nextActive) this.materializeTab(src, nextActive);
      this.notifyExtensionsActiveTab(src);
      this.layout(src);
      this.pushTabs(src);
      this.saveSession(src);
    }
    const dstTab = dst.state.tabs.find((t) => t.id === tabId);
    if (dstTab) this.materializeTab(dst, dstTab);
    this.notifyExtensionsActiveTab(dst);
    this.layout(dst);
    this.pushTabs(dst);
    this.saveSession(dst);
  }
  /** Move a tab into a specific existing window (both must be the same profile) —
   * the deterministic, pilotable counterpart to the drag-driven detachTabTo. */
  moveTabToWindowById(tabId, targetWindowId) {
    const src = this.ownerOf(tabId);
    if (!src) throw new Error(`unknown tab: ${tabId}`);
    if (tabId === src.settingsTabId) throw new Error("cannot move the Settings tab");
    const dst = this.openById.get(targetWindowId);
    if (!dst || dst.window.isDestroyed()) throw new Error(`unknown window: ${targetWindowId}`);
    if (dst === src) return { windowId: targetWindowId };
    if (dst.id !== src.id) throw new Error("cannot move a tab to a window of another profile");
    this.attachTab(src, dst, tabId);
    if (!dst.window.isDestroyed()) dst.window.focus();
    return { windowId: targetWindowId };
  }
  /** Make `tabId` the visible/active tab in its own window, and bring that window
   * forward — wherever the tab lives. The cross-window counterpart to selectTabIn
   * (which only acts on the focused window's context). Real-input commands need
   * this first: Chromium drops input on a hidden tab. Throws on an unknown tab. */
  activateTabById(tabId) {
    const pw = this.ownerOf(tabId);
    if (!pw) throw new Error(`unknown tab: ${tabId}`);
    if (!pw.window.isDestroyed()) {
      pw.window.show();
      pw.window.focus();
    }
    this.selectTabIn(pw, tabId);
    return { windowId: pw.windowId, id: tabId };
  }
  /** True when the tab's page reports `document.visibilityState === 'visible'`.
   * Read over the same CDP eval path exec-js uses (works even on a hidden tab).
   * Never throws — a failed probe reads as "not visible". */
  async isPageVisible(wc) {
    try {
      return await evalInWebContents(wc, "document.visibilityState") === "visible";
    } catch {
      return false;
    }
  }
  /** Ensure `wc`'s tab is visible so real input (press-key) can land. If already
   * visible, a no-op. Otherwise activate its tab (raise the window + select it),
   * then poll until the page reports visible (layout + compositor need a beat).
   * Returns whether it became visible within the budget. */
  async ensurePageVisibleForInput(wc, id) {
    if (await this.isPageVisible(wc)) return true;
    if (id) {
      try {
        this.activateTabById(id);
      } catch {
      }
    }
    for (let i = 0; i < 20; i++) {
      if (await this.isPageVisible(wc)) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }
  /** Every open window: its id, profile, tab count, and screen frame — for the
   * socket/MCP to enumerate windows and target a move. */
  listOpenWindows() {
    const focused = this.findByWindow(electron.BrowserWindow.getFocusedWindow());
    const out = [];
    for (const pw of this.openById.values()) {
      if (pw.window.isDestroyed()) continue;
      const b = pw.window.getBounds();
      out.push({
        windowId: pw.windowId,
        profileId: pw.id,
        tabCount: pw.state.tabs.length,
        bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
        focused: pw === focused
      });
    }
    return out;
  }
  /** Enable CDP Network events on a tab's already-attached debugger and route
   * every image / audio-video / font response into that tab's MediaBuffer. The
   * debugger is shared with stealth's shim (see stealth.ts / cdp-eval.ts) —
   * enabling the Network domain and listening for messages is independent of the
   * Page domain it drives, so they coexist. Best-effort: capture failing must
   * never break the page, so errors are logged and swallowed. */
  startMediaCaptureFor(pw, tabId, wc) {
    const buffer = pw.media.get(tabId) ?? new MediaBuffer();
    pw.media.set(tabId, buffer);
    const dbg = wc.debugger;
    try {
      if (!dbg.isAttached()) dbg.attach("1.3");
    } catch (error) {
      console.error("[mira] media capture: debugger attach failed", error);
      return;
    }
    dbg.on("message", (_event, method, params) => {
      if (method !== "Network.responseReceived") return;
      const p = params;
      const type = p.type;
      if (type !== "Image" && type !== "Media" && type !== "Font") return;
      const res = p.response;
      if (!res?.url) return;
      buffer.add({
        url: res.url,
        mime: res.mimeType,
        resourceType: type,
        bytes: typeof res.encodedDataLength === "number" ? res.encodedDataLength : void 0
      });
    });
    dbg.sendCommand("Network.enable").catch((error) => {
      console.error("[mira] media capture: Network.enable failed", error);
    });
  }
  /** Open / close / toggle the fullscreen media gallery overlay in `pw`. Mirrors
   * the palette: hide the active web view (via layout) so the chrome overlay is
   * visible, hand focus to the chrome, and push the state so the chrome renders
   * or dismisses the gallery. */
  setMediaGalleryOpenIn(pw, open) {
    const next = open ?? !pw.mediaGalleryOpen;
    pw.mediaGalleryOpen = next;
    this.layout(pw);
    if (!pw.window.isDestroyed()) {
      if (next) pw.window.webContents.focus();
      pw.window.webContents.send("mira:media-gallery", { open: next });
    }
    return { open: next };
  }
  /** Resolve a tab to its live webContents and media buffer for the media
   * commands. With a `tabId`, looks across ALL windows (ids are UUIDs) so a
   * socket/MCP caller can target any tab; without one, the target window's active
   * tab. Mirrors execJsInTab's errors (unknown / asleep / Settings / no page). */
  resolveMediaTab(target, tabId) {
    if (tabId) {
      for (const pw of this.openById.values()) {
        if (pw.window.isDestroyed()) continue;
        const view2 = pw.views.get(tabId);
        if (view2) return { wc: view2.webContents, buffer: pw.media.get(tabId) };
        if (tabId === pw.settingsTabId) throw new Error("not a web page (Settings tab)");
        if (pw.state.tabs.some((t) => t.id === tabId)) throw new Error(`tab is asleep: ${tabId}`);
      }
      throw new Error(`unknown tab: ${tabId}`);
    }
    if (!target || target.window.isDestroyed()) throw new Error("no target window");
    const activeId = target.state.activeId;
    if (!activeId || activeId === target.settingsTabId) throw new Error("no active web page");
    const view = target.views.get(activeId);
    if (!view) throw new Error("no active tab");
    return { wc: view.webContents, buffer: target.media.get(activeId) };
  }
  /** Resolve a tab's OWN webContents for input injection. Same lookup and error
   * semantics as execJsInTab: with a `tabId`, search ALL windows (UUIDs are
   * global); without one, the target window's active tab. Throws on an
   * unknown/asleep tab, the Settings tab, or no active web page. */
  webContentsForTab(target, tabId) {
    if (tabId) {
      for (const pw of this.openById.values()) {
        if (pw.window.isDestroyed()) continue;
        const view2 = pw.views.get(tabId);
        if (view2) return view2.webContents;
        if (tabId === pw.settingsTabId) throw new Error("not a web page (Settings tab)");
        if (pw.state.tabs.some((t) => t.id === tabId)) throw new Error(`tab is asleep: ${tabId}`);
      }
      throw new Error(`unknown tab: ${tabId}`);
    }
    if (!target || target.window.isDestroyed()) throw new Error("no target window");
    const activeId = target.state.activeId;
    if (!activeId || activeId === target.settingsTabId) throw new Error("no active web page");
    const view = target.views.get(activeId);
    if (!view) throw new Error("no active tab");
    return view.webContents;
  }
  /** Save one media url to `dir`. A data: URL is decoded and written directly; an
   * http(s) url is fetched through the tab's OWN session (so authenticated media
   * carry the page's cookies) and written. The filename is derived from the url /
   * mime and de-duplicated against `used` (and any file already on disk). Throws
   * on a failed fetch so the caller can count it as failed. */
  async saveMediaUrl(wc, url2, dir, used) {
    let bytes;
    let mime = "";
    if (url2.startsWith("data:")) {
      const comma = url2.indexOf(",");
      if (comma < 0) throw new Error("malformed data: URL");
      const header = url2.slice(5, comma);
      const body = url2.slice(comma + 1);
      const isBase64 = /;base64$/i.test(header);
      mime = header.replace(/;base64$/i, "") || "application/octet-stream";
      bytes = isBase64 ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body), "utf8");
    } else if (url2.startsWith("blob:")) {
      const code = `(async () => {
        const r = await fetch(${JSON.stringify(url2)})
        const b = await r.blob()
        const buf = new Uint8Array(await b.arrayBuffer())
        let s = ''
        for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i])
        return JSON.stringify({ mime: b.type, data: btoa(s) })
      })()`;
      const raw = await evalInWebContents(wc, code);
      const parsed = JSON.parse(typeof raw === "string" ? raw : "{}");
      if (!parsed.data) throw new Error("blob not fetchable (streamed media)");
      mime = parsed.mime ?? "";
      bytes = Buffer.from(parsed.data, "base64");
    } else {
      const res = await wc.session.fetch(url2);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      mime = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      bytes = Buffer.from(await res.arrayBuffer());
    }
    const name = uniqueFileName(fileNameFor(url2, mime), dir, used);
    used.add(name);
    await promises.writeFile(node_path.join(dir, name), bytes);
  }
  /** Download a streamed video (MSE/HLS/blob — e.g. X) as a real file via yt-dlp.
   * `pageUrl` is the PRECISE permalink for that one video, resolved from the DOM;
   * yt-dlp extracts and muxes it. This runs in a background process with nothing
   * kept open — the key advantage over the old in-page recorder, which pinned the
   * tab to the playing page. Registered in activeDownloads so the status bar shows
   * a download is in flight. Resolves with the saved basename or a clean error. */
  async downloadVideoUrl(pageUrl) {
    const id = ++this.downloadSeq;
    this.activeDownloads.set(id, { startedAt: Date.now() });
    try {
      return await ytdlpDownload(pageUrl, electron.app.getPath("downloads"), process.env);
    } finally {
      this.activeDownloads.delete(id);
    }
  }
  /** Tear down a tab's docked DevTools host view (if any): remove it from the
   * window and close its webContents. Safe to call for a tab that has none. The
   * page's own inspector connection dies with its webContents, so this only frees
   * the host view. */
  destroyDevToolsView(pw, id) {
    const devtools = pw.devtools.get(id);
    if (!devtools) return;
    pw.devtools.delete(id);
    pw.window.contentView.removeChildView(devtools);
    devtools.webContents.close();
  }
  /** Toggle the docked DevTools inspector for the active tab. Opening creates a
   * host WebContentsView, points the page's DevTools at it (setDevToolsWebContents
   * + openDevTools detached-into-our-view), and re-lays-out so it docks on the
   * right; closing tears the host down. Returns whether DevTools are open after.
   * Throws when there is no active web page (empty window / Settings tab).
   *
   * `mode: 'detach'` here does NOT spawn an OS window — combined with
   * setDevToolsWebContents it renders the inspector INTO our host view, which
   * layout() positions by hand. That is the whole point over the native docked
   * mode, which draws relative to the page bounds and overlapped the toolbar. */
  toggleActiveDevTools(pw) {
    const id = pw.state.activeId;
    if (!id || id === pw.settingsTabId) throw new Error("no active web page");
    const view = pw.views.get(id);
    if (!view) throw new Error("no active tab");
    if (pw.devtools.has(id)) {
      view.webContents.closeDevTools();
      this.destroyDevToolsView(pw, id);
      this.layout(pw);
      return false;
    }
    this.openActiveDevTools(pw, id, view);
    return true;
  }
  /** Ensure the active tab's docked DevTools host view exists, creating it on the
   * first call. Returns the host and whether it was just created (so callers can
   * wait for the frontend to finish loading before driving it). */
  openActiveDevTools(pw, id, view) {
    const existing = pw.devtools.get(id);
    if (existing) return { host: existing, created: false };
    const host = new electron.WebContentsView();
    pw.window.contentView.addChildView(host);
    pw.devtools.set(id, host);
    view.webContents.setDevToolsWebContents(host.webContents);
    view.webContents.openDevTools({ mode: "detach" });
    this.layout(pw);
    return { host, created: true };
  }
  /** Open the active tab's docked DevTools (if needed) and reveal the Cookies
   * view of the Application panel. The reveal drives the DevTools frontend — which
   * is Chromium's own chrome and whose internals shift between versions — so the
   * script is self-retrying and fully wrapped in try/catch: at worst DevTools stay
   * open on their default panel. Never closes an already-open inspector. Returns
   * true (DevTools are open after). Throws when there is no active web page. */
  async inspectCookiesInActive(pw) {
    const id = pw.state.activeId;
    if (!id || id === pw.settingsTabId) throw new Error("no active web page");
    const view = pw.views.get(id);
    if (!view) throw new Error("no active tab");
    const { host, created } = this.openActiveDevTools(pw, id, view);
    if (created && host.webContents.isLoadingMainFrame()) {
      await new Promise(
        (resolve) => host.webContents.once("did-finish-load", () => resolve())
      );
    }
    try {
      await host.webContents.executeJavaScript(REVEAL_COOKIES_SCRIPT);
    } catch {
    }
    return true;
  }
  /** Discard a specific tab's page but keep the tab. If it is the active tab,
   * focus moves as in discardActiveTabIn; a background tab just loses its view.
   * Throws on an unknown id. */
  discardTabIn(pw, id) {
    const tab = pw.state.tabs.find((t) => t.id === id);
    if (!tab) throw new Error(`unknown tab: ${id}`);
    if (tab.keepAwake === true) return { discarded: false, id };
    if (pw.state.activeId === id) {
      this.discardActiveTabIn(pw);
      return { discarded: true, id };
    }
    this.discardView(pw, id);
    this.pushTabs(pw);
    this.saveSession(pw);
    return { discarded: true, id };
  }
  /** Discard the active tab's page (Cmd+S): tear down its view to reclaim RAM,
   * keep the tab in the strip (asleep), and move focus to the nearest OTHER
   * already-loaded tab — never waking a sleeping one, else discarding would just
   * reload a page. If no other tab is loaded, a fresh home tab is opened to land
   * on and the discarded tab stays asleep. Returns the discarded id, or null if
   * there was no active tab. */
  discardActiveTabIn(pw) {
    const id = pw.state.activeId;
    if (!id) return { discarded: false, id: null };
    if (pw.state.tabs.find((t) => t.id === id)?.keepAwake === true) {
      return { discarded: false, id };
    }
    const target = nextLoadedTab(pw.state, new Set(pw.views.keys()));
    if (target) {
      pw.state = selectTab(pw.state, target);
      pw.closeArmedId = null;
      this.discardView(pw, id);
      this.notifyExtensionsActiveTab(pw);
      this.layout(pw);
      this.pushTabs(pw);
      this.saveSession(pw);
    } else {
      this.newTabIn(pw, this.appSettings.homeUrl, true);
      this.discardView(pw, id);
      this.pushTabs(pw);
      this.saveSession(pw);
    }
    return { discarded: true, id };
  }
  /** Wake (materialize + load) every tab that was awake at the previous quit and
   * is still in the strip — the Cmd+Shift+A target. Focus is untouched; already
   * loaded tabs (the active one, any woken earlier) are skipped by materializeTab.
   * Returns how many tabs it actually woke this call. */
  wakeAllTabsIn(pw) {
    let woken = 0;
    for (const tab of pw.state.tabs) {
      if (!pw.restoredLoadedIds.has(tab.id)) continue;
      if (pw.views.has(tab.id)) continue;
      this.materializeTab(pw, tab);
      woken++;
    }
    if (woken > 0) {
      this.layout(pw);
      this.pushTabs(pw);
      this.saveSession(pw);
    }
    return { woken };
  }
  selectTabIn(pw, id) {
    const tab = pw.state.tabs.find((t) => t.id === id);
    if (!tab) throw new Error(`unknown tab: ${id}`);
    pw.state = selectTab(pw.state, id);
    pw.closeArmedId = null;
    const wasLoaded = pw.views.has(id);
    this.materializeTab(pw, tab);
    if (wasLoaded && tab.url === "" && id !== pw.settingsTabId) {
      pw.views.get(id)?.webContents.loadURL(this.blankPageUrl(pw));
    }
    this.notifyExtensionsActiveTab(pw);
    this.layout(pw);
    this.pushTabs(pw);
    this.saveSession(pw);
    return { id };
  }
  /** Intercept Cmd+Up / Cmd+Down on `wc` (before the page or the macOS text
   * system can act on them) and step the tab strip. Wired on both the chrome and
   * every tab webContents so the shortcut works whatever holds focus. The menu
   * items carry the same accelerator for display only (registerAccelerator:false,
   * see menu.ts) so it is not handled twice. */
  wireTabShortcuts(initialPw, wc) {
    wc.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const mod = process.platform === "darwin" ? input.meta : input.control;
      if (!mod) return;
      const pw = this.ownerByWebContents(wc) ?? initialPw;
      if (!input.shift && !input.alt && input.key === "ArrowUp") {
        this.selectAdjacentTabIn(pw, -1);
        event.preventDefault();
      } else if (!input.shift && !input.alt && input.key === "ArrowDown") {
        this.selectAdjacentTabIn(pw, 1);
        event.preventDefault();
      } else if (input.alt && input.key === "ArrowLeft") {
        this.stepMruIn(pw, -1);
        event.preventDefault();
      } else if (input.alt && input.key === "ArrowRight") {
        this.stepMruIn(pw, 1);
        event.preventDefault();
      }
    });
  }
  /** Wire the optical magnifier onto a tab's webContents, reusing the CDP
   * debugger stealth already attached. Two hooks:
   *  1. Inject the input shim + register its forwarding binding (re-asserted on
   *     each navigation, which also resets the zoom — a new page starts at 100%).
   *  2. Route the shim's forwarded wheel to magnifier-zoom (Cmd held) or -pan.
   *     All routing goes through the window's chrome webContents so the command
   *     context resolves the window (BrowserWindow.fromWebContents on a child
   *     view can be null).
   * Cmd detection is NOT tracked from main: the shim reads e.metaKey off the
   * wheel event itself (see MAGNIFIER_SHIM). A main-side "Cmd is held" boolean
   * was tried and removed: its keyUp could land on the chrome, another tab or
   * another app, leaving it stuck true — and the stale flag was then re-pushed
   * into every freshly loaded page, whose shim swallowed all plain wheel events
   * ("the page refuses to scroll after load" bug). */
  wireMagnifier(initialPw, tabId, wc) {
    const owner = () => this.ownerOf(tabId) ?? initialPw;
    const dbg = wc.debugger;
    const inject = () => {
      try {
        if (!dbg.isAttached()) dbg.attach("1.3");
        dbg.sendCommand("Runtime.enable").catch(() => {
        });
        dbg.sendCommand("Runtime.addBinding", { name: MAG_BINDING }).catch(() => {
        });
        dbg.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: MAGNIFIER_SHIM }).catch(() => {
        });
        evalInWebContents(wc, MAGNIFIER_SHIM).catch(() => {
        });
      } catch {
      }
    };
    inject();
    wc.on("did-finish-load", () => {
      this.magnifierStates.delete(tabId);
      this.shimFlags.delete(tabId);
      inject();
      this.applyMagnifier(owner(), tabId);
    });
    dbg.on("message", (_e, method, params) => {
      if (method !== "Runtime.bindingCalled" || params.name !== MAG_BINDING) return;
      let msg;
      try {
        msg = JSON.parse(params.payload);
      } catch {
        return;
      }
      if (msg.t !== "wheel") return;
      const pw = owner();
      const chrome = pw.window.webContents;
      if (msg.meta) {
        const cursor = this.cursorInView(pw, tabId);
        if (!cursor) return;
        this.deps.runCommand?.(chrome, "magnifier-zoom", {
          deltaY: msg.dy ?? 0,
          cursorX: cursor.x,
          cursorY: cursor.y
        });
      } else {
        this.deps.runCommand?.(chrome, "magnifier-pan", {
          deltaX: msg.dx ?? 0,
          deltaY: msg.dy ?? 0
        });
      }
    });
  }
  /** Apply tab `tabId`'s current magnifier state to its view: set (or clear) the
   * page-root CSS transform that realizes the zoom, and refresh the shim flags.
   * A composited transform is exact at every scale (the CDP viewport clip, tried
   * first, broke above ~2× — see magnifier.ts). */
  applyMagnifier(pw, tabId) {
    const view = pw.views.get(tabId);
    if (!view) return;
    const wc = view.webContents;
    const state = this.magnifierStates.get(tabId) ?? NO_MAGNIFIER;
    const magnified = isMagnified(state);
    const js = magnified ? applyMagnifierJs(state) : CLEAR_MAGNIFIER_JS;
    evalInWebContents(wc, js).catch(() => {
    });
    evalInWebContents(wc, magnifierFrameJs(magnified)).catch(() => {
    });
    this.updateShim(tabId, wc);
  }
  /** Push the shim's two capture flags for a tab, skipping the JS eval when they
   * have not changed. Both flags follow the magnified state and nothing else:
   * captureWheel while magnified (pan keeps working after Cmd is released) — the
   * first Cmd+scroll from 100% is caught by the shim's own e.metaKey read, not by
   * a flag from main; swallowClicks while magnified (Cmd+click still opens links
   * when not zoomed). */
  updateShim(tabId, wc) {
    const magnified = isMagnified(this.magnifierStates.get(tabId) ?? NO_MAGNIFIER);
    const js = setShimFlags(magnified, magnified);
    if (this.shimFlags.get(tabId) === js) return;
    this.shimFlags.set(tabId, js);
    evalInWebContents(wc, js).catch(() => {
    });
  }
  /** The cursor's position inside a tab's view, in surface CSS px (the space the
   * magnifier clip lives in), or null if the view is gone. Screen points are CSS
   * px on macOS, so this is: global cursor − window content origin − view offset.
   * Read live from main because the page's own clientX drifts once a clip is on. */
  cursorInView(pw, tabId) {
    const view = pw.views.get(tabId);
    if (!view || pw.window.isDestroyed()) return null;
    const cursor = electron.screen.getCursorScreenPoint();
    const content = pw.window.getContentBounds();
    const bounds = view.getBounds();
    return { x: cursor.x - content.x - bounds.x, y: cursor.y - content.y - bounds.y };
  }
  /** Pop up the native page right-click menu for `wc`. The item set is decided by
   * the pure, tested buildPageMenu (from the click target + this view's history);
   * here we only translate it to Electron menu items and popup. Mira actions
   * (`command` items) route through deps.runCommand so they hit the same registry
   * bus as the toolbar / socket; clipboard items are native roles on the view. */
  wireContextMenu(initialPw, wc) {
    wc.on("context-menu", (_event, params) => {
      const pw = this.ownerByWebContents(wc) ?? initialPw;
      if (pw.window.isDestroyed()) return;
      const items = buildPageMenu({
        linkURL: params.linkURL,
        selectionText: params.selectionText,
        isEditable: params.isEditable,
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        mediaType: params.mediaType,
        srcURL: params.srcURL
      });
      const template = items.map((item) => {
        if (item.type === "separator") return { type: "separator" };
        if (item.type === "role") return { role: item.role, label: item.label };
        if (item.type === "download-stream") {
          return {
            label: item.label,
            click: () => void this.downloadStreamAt(wc, params.x, params.y)
          };
        }
        if (item.type === "inspect-element") {
          return {
            label: item.label,
            click: () => this.inspectElementAt(wc, params.x, params.y)
          };
        }
        return {
          label: item.label,
          enabled: item.enabled,
          click: () => this.deps.runCommand?.(wc, item.command, item.params)
        };
      });
      const menu = electron.Menu.buildFromTemplate(template);
      const extensionItems = this.deps.extensions.contextMenuItems(wc, params);
      if (extensionItems.length > 0) {
        menu.append(new electron.MenuItem({ type: "separator" }));
        for (const item of extensionItems) menu.append(item);
      }
      menu.popup({ window: pw.window });
    });
  }
  /** Pop the native right-click menu for a tab in the sidebar. The item list is
   * the pure, tested buildTabMenu (fed this window's folders + the tab's own
   * folder); the popup below is the thin native part (like the page menu). Command
   * items route through deps.runCommand so they hit the same registry bus as
   * everything else, targeting THIS window's chrome. No-op on an unknown tab id or
   * a destroyed window. */
  showTabMenuIn(pw, tabId) {
    if (pw.window.isDestroyed()) return;
    const tab = pw.state.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const chrome = pw.window.webContents;
    const items = buildTabMenu(
      {
        id: tab.id,
        pinned: tab.pinned === true,
        keepAwake: tab.keepAwake === true,
        folderId: tab.folderId ?? null
      },
      pw.folders.map((f) => ({ id: f.id, title: f.title }))
    );
    const template = items.map((item) => this.tabMenuItemToTemplate(item, chrome, tabId));
    electron.Menu.buildFromTemplate(template).popup({ window: pw.window });
  }
  /** Convert one pure TabMenuItem to a native menu item, recursing into submenus.
   * Command items fire on the registry bus; `duplicate` is the select-then-
   * duplicate special case (no duplicate-by-id command exists — runDetached queues
   * both as microtasks in order, so select lands before duplicate reads the active
   * id). `chrome`/`tabId` are captured for the click handlers. */
  tabMenuItemToTemplate(item, chrome, tabId) {
    if (item.type === "separator") return { type: "separator" };
    if (item.type === "submenu") {
      return {
        label: item.label,
        submenu: item.items.map((sub) => this.tabMenuItemToTemplate(sub, chrome, tabId))
      };
    }
    if (item.type === "duplicate") {
      return {
        label: item.label,
        click: () => {
          this.deps.runCommand?.(chrome, "select-tab", { id: tabId });
          this.deps.runCommand?.(chrome, "duplicate-active-tab");
        }
      };
    }
    return {
      label: item.label,
      enabled: item.enabled,
      click: () => this.deps.runCommand?.(chrome, item.command, item.params)
    };
  }
  /** Pop the native drop-down for the toolbar audio button: this window's audible
   * tabs (in strip order), click one to focus it. Item list from the pure, tested
   * buildAudioMenu; the popup is the thin native part (like the tab menu). Command
   * items route through deps.runCommand so they hit the same registry bus. No-op on
   * a destroyed window; shows a disabled placeholder when nothing is playing. */
  showAudioMenuIn(pw) {
    if (pw.window.isDestroyed()) return;
    const chrome = pw.window.webContents;
    const audible = pw.state.tabs.filter(
      (t) => pw.views.get(t.id)?.webContents.isCurrentlyAudible() === true
    );
    const items = buildAudioMenu(audible.map((t) => ({ id: t.id, title: t.title, url: t.url })));
    const template = items.map((item) => this.audioMenuItemToTemplate(item, chrome));
    electron.Menu.buildFromTemplate(template).popup({ window: pw.window });
  }
  /** Convert one pure AudioMenuItem to a native menu item. Command items fire on
   * the registry bus (select-tab); the `disabled` placeholder is a greyed, inert
   * entry. `chrome` is captured for the click handlers. */
  audioMenuItemToTemplate(item, chrome) {
    if (item.type === "disabled") return { label: item.label, enabled: false };
    return {
      label: item.label,
      click: () => this.deps.runCommand?.(chrome, item.command, item.params)
    };
  }
  /** Pop the native right-click menu for a folder header in the sidebar. Item
   * list from the pure, tested buildFolderMenu (fed the folder's collapse state +
   * color); the popup is the thin native part. No-op on an unknown folder id or a
   * destroyed window. */
  showFolderMenuIn(pw, folderId) {
    if (pw.window.isDestroyed()) return;
    const folder = pw.folders.find((f) => f.id === folderId);
    if (!folder) return;
    const chrome = pw.window.webContents;
    const items = buildFolderMenu({
      id: folder.id,
      collapsed: folder.collapsed,
      color: folder.color ?? null
    });
    const template = items.map((item) => this.folderMenuItemToTemplate(item, chrome));
    electron.Menu.buildFromTemplate(template).popup({ window: pw.window });
  }
  /** Convert one pure FolderMenuItem to a native menu item, recursing into
   * submenus. Command items fire on the registry bus; `checked` renders a native
   * checkmark (the active color). `chrome` is captured for the click handlers. */
  folderMenuItemToTemplate(item, chrome) {
    if (item.type === "separator") return { type: "separator" };
    if (item.type === "submenu") {
      return {
        label: item.label,
        submenu: item.items.map((sub) => this.folderMenuItemToTemplate(sub, chrome))
      };
    }
    return {
      label: item.label,
      enabled: item.enabled,
      ...item.checked !== void 0 ? { type: "checkbox", checked: item.checked } : {},
      click: () => this.deps.runCommand?.(chrome, item.command, item.params)
    };
  }
  /** Right-click "Download Video" on a streamed video: resolve the precise
   * permalink for the video at the click point (in the tab's DOM), then route it
   * to the `download-video-url` command (yt-dlp). Falls back to the page URL when
   * no permalink is found. Best-effort — logs and gives up on failure. */
  async downloadStreamAt(wc, x, y) {
    try {
      const resolved = await evalInWebContents(wc, nearestVideoPermalinkSource(x, y));
      const url2 = typeof resolved === "string" && resolved ? resolved : wc.getURL();
      if (!url2) return;
      this.deps.runCommand?.(wc, "download-video-url", { url: url2 });
    } catch (error) {
      console.error("[mira] download-stream: could not resolve video URL", error);
    }
  }
  /** Open the docked DevTools for the right-clicked tab and reveal the Elements
   * panel with the element at (x, y) selected — the Chrome "Inspect Element"
   * flow. openActiveDevTools ensures the inspector renders INTO our host view
   * (not a native docked panel that overlaps the toolbar); inspectElement then
   * switches to Elements and selects the node at the click point. No-op if the
   * tab's window/view is gone. */
  inspectElementAt(wc, x, y) {
    const pw = this.ownerByWebContents(wc);
    if (!pw || pw.window.isDestroyed()) return;
    const id = this.tabIdForWebContents(pw, wc);
    if (!id) return;
    const view = pw.views.get(id);
    if (!view) return;
    this.openActiveDevTools(pw, id, view);
    wc.inspectElement(x, y);
  }
  /** Step to the tab one position from the active one (arrow up/down): -1 for the
   * previous, +1 for the next. Wraps around the ends. Steps through every tab,
   * asleep or not — the target materializes on selection. */
  selectAdjacentTabIn(pw, direction) {
    const target = nextNavigableTabId(pw.state.tabs, pw.folders, pw.state.activeId, direction);
    if (!target) return { id: null };
    this.selectTabIn(pw, target);
    return { id: target };
  }
  moveTabIn(pw, id, toIndex) {
    if (!pw.state.tabs.some((t) => t.id === id)) throw new Error(`unknown tab: ${id}`);
    pw.state = moveTab(pw.state, id, toIndex);
    this.pushTabs(pw);
    this.saveSession(pw);
    return { id };
  }
  /** Pin or unpin a tab. Pinning moves it into the block of squares at the head
   * of the strip; unpinning drops it back to the head of the regular tabs (see
   * pinTab / unpinTab in tab-store). Order-only: the active view is untouched,
   * so no re-layout — just push the new strip and persist it. Throws on an
   * unknown id. */
  setTabPinnedIn(pw, id, pinned) {
    if (!pw.state.tabs.some((t) => t.id === id)) throw new Error(`unknown tab: ${id}`);
    pw.state = pinned ? pinTab(pw.state, id) : unpinTab(pw.state, id);
    if (pinned) pw.state = setTabFolder(pw.state, id, null);
    this.pushTabs(pw);
    this.saveSession(pw);
    return { id, pinned };
  }
  /** Set or clear a tab's keep-awake flag. Turning it ON wakes the tab if it was
   * asleep (a kept-awake tab must be live by definition) and lays out so the
   * freshly materialized background view is hidden behind the active one; turning
   * it OFF just drops the flag (the tab stays as loaded as it currently is). Throws
   * on an unknown id. */
  setTabKeepAwakeIn(pw, id, keepAwake) {
    const tab = pw.state.tabs.find((t) => t.id === id);
    if (!tab) throw new Error(`unknown tab: ${id}`);
    pw.state = setKeepAwake(pw.state, id, keepAwake);
    if (keepAwake && !pw.views.has(id) && id !== pw.settingsTabId) {
      this.materializeTab(pw, tab);
      this.layout(pw);
    }
    this.pushTabs(pw);
    this.saveSession(pw);
    return { id, keepAwake };
  }
  // --- Tab folders. Metadata lives in pw.folders; membership on each tab's
  // folderId. Every mutation re-pushes the strip + folders and persists. ---
  createTabFolderIn(pw, title, tabId) {
    const id = crypto.randomUUID();
    pw.folders = addFolder(pw.folders, { id, title, collapsed: false });
    if (tabId) {
      const tab = pw.state.tabs.find((t) => t.id === tabId);
      if (tab && tab.pinned !== true) pw.state = setTabFolder(pw.state, tabId, id);
    }
    this.pushTabs(pw);
    this.saveSession(pw);
    return { id };
  }
  renameTabFolderIn(pw, id, title) {
    if (!hasFolder(pw.folders, id)) return { renamed: false };
    pw.folders = renameFolder(pw.folders, id, title);
    this.pushTabs(pw);
    this.saveSession(pw);
    return { renamed: true };
  }
  removeTabFolderIn(pw, id) {
    if (!hasFolder(pw.folders, id)) return { removed: false };
    pw.folders = removeFolder(pw.folders, id);
    pw.state = clearFolderMembership(pw.state, id);
    this.pushTabs(pw);
    this.saveSession(pw);
    return { removed: true };
  }
  toggleTabFolderIn(pw, id, collapsed) {
    if (!hasFolder(pw.folders, id)) throw new Error(`unknown folder: ${id}`);
    pw.folders = setFolderCollapsed(pw.folders, id, collapsed);
    this.pushTabs(pw);
    this.saveSession(pw);
    return { collapsed: pw.folders.find((f) => f.id === id).collapsed };
  }
  setTabFolderColorIn(pw, id, color) {
    if (!hasFolder(pw.folders, id)) return { updated: false };
    pw.folders = setFolderColor(pw.folders, id, color);
    this.pushTabs(pw);
    this.saveSession(pw);
    return { updated: true };
  }
  moveTabToFolderIn(pw, tabId, folderId) {
    const tab = pw.state.tabs.find((t) => t.id === tabId);
    if (!tab) return { moved: false };
    if (folderId !== null && !hasFolder(pw.folders, folderId)) return { moved: false };
    if (tab.pinned === true && folderId !== null) return { moved: false };
    pw.state = setTabFolder(pw.state, tabId, folderId);
    this.pushTabs(pw);
    this.saveSession(pw);
    return { moved: true };
  }
  toggleTabsPanelIn(pw, collapsed) {
    pw.panelCollapsed = collapsed ?? !pw.panelCollapsed;
    if (pw.htmlFullScreen) {
      pw.htmlFullScreen = panelChanged(pw.htmlFullScreen, { tabsCollapsed: pw.panelCollapsed });
    }
    this.layout(pw);
    this.pushTabs(pw);
    this.saveSession(pw);
    return { collapsed: pw.panelCollapsed };
  }
  /** Toggle zen (focus) mode: hide/show the toolbar, status bar, and both side
   * panels together, restoring the panels to their pre-zen state on exit. The
   * pure state transition (snapshot on entry, restore on exit) lives in nextZen;
   * here we only apply it. Setting chromeHidden BEFORE toggling the panels makes
   * the pushTabs inside toggleTabsPanelIn carry the new zen flag to the chrome. */
  toggleZenIn(pw, hidden) {
    const live = { tabsCollapsed: pw.panelCollapsed, skillPaneOpen: pw.skillPane.open };
    const { zen, apply } = nextZen(
      { hidden: pw.chromeHidden, snapshot: pw.zenSnapshot },
      live,
      hidden
    );
    pw.chromeHidden = zen.hidden;
    pw.zenSnapshot = zen.snapshot;
    this.toggleTabsPanelIn(pw, apply.tabsCollapsed);
    this.setSkillPaneIn(pw, { ...pw.skillPane, open: apply.skillPaneOpen });
    return { hidden: zen.hidden };
  }
  /** Add a url favorite under `parentId` (a folder id, or undefined = top level).
   * With no url, bookmark `target`'s active tab. Idempotent by url — an
   * already-saved page (anywhere in the tree) returns the existing node with
   * created:false and no write. Throws when a url must be resolved from the active
   * tab but there is none, or when parentId is unknown / not a folder. */
  /** Add a url favorite. With no url, bookmark `target`'s active tab (resolving the
   * url/title here is the only window-bound part; the tree work is the controller's).
   * Idempotent by url — see BookmarksController.addUrl. */
  addBookmarkIn(target, url2, title, parentId) {
    if (!target || target.window.isDestroyed()) throw new Error("no target window");
    let finalUrl = url2;
    let finalTitle = title;
    if (finalUrl === void 0) {
      const active = target.state.tabs.find((t) => t.id === target.state.activeId);
      if (!active) throw new Error("no active tab");
      finalUrl = active.url;
      if (finalTitle === void 0) finalTitle = active.title;
    }
    return this.bookmarksFor(target.id).addUrl(finalUrl, finalTitle ?? "", parentId);
  }
  /** Open a favorite's url in a new tab of `target` and focus it (address-bar
   * focus, like any other new tab). Throws on an unknown id, a folder id, or no
   * target. */
  openBookmarkIn(target, id) {
    if (!target || target.window.isDestroyed()) throw new Error("no target window");
    const url2 = this.bookmarksFor(target.id).urlFor(id);
    const tab = this.newTabIn(target, url2, true);
    return { tabId: tab.id, url: url2 };
  }
  /** The FOCUSED profile's favorites tree, for the native Bookmarks menu (menu.ts,
   * via index.ts). The menu is app-global but shows one profile at a time; it is
   * rebuilt on focus change (onChange), so it always mirrors the front window. */
  listBookmarksTree() {
    const id = this.focusedId() ?? this.openById.values().next().value?.id;
    return id ? this.bookmarksFor(id).get() : [];
  }
  listProfiles() {
    return {
      profiles: this.profiles.map((p) => ({
        ...this.toProfileInfo(p),
        open: this.windowsForProfile(p.id).length > 0
      })),
      focused: this.focusedId()
    };
  }
  /** Cross-profile snapshot of every loaded tab with the memory of its renderer
   * process, ranked heaviest-first. Walks every OPEN profile window (a closed
   * profile has no live views), maps each loaded tab to its OS pid, and reads the
   * pid's working set from the app metrics. Asleep tabs and the Settings tab have
   * no WebContentsView, so they never appear. The `shared` count and the distinct
   * total account for renderer reuse (several same-site tabs on one process). */
  listTabMemory() {
    const memoryByPid = /* @__PURE__ */ new Map();
    for (const m of this.deps.getProcessMemory()) memoryByPid.set(m.pid, m.bytes);
    const raw = [];
    const tabsPerPid = /* @__PURE__ */ new Map();
    for (const pw of this.openById.values()) {
      const label = findById(this.profiles, pw.id)?.label ?? pw.id;
      for (const tab of pw.state.tabs) {
        const view = pw.views.get(tab.id);
        if (!view) continue;
        let pid;
        try {
          pid = view.webContents.getOSProcessId();
        } catch {
          continue;
        }
        if (!pid) continue;
        tabsPerPid.set(pid, (tabsPerPid.get(pid) ?? 0) + 1);
        raw.push({
          tabId: tab.id,
          profileId: pw.id,
          profileLabel: label,
          title: tab.title || tab.url || "Untitled",
          url: tab.url,
          favicon: tab.favicon,
          pid,
          processMemoryBytes: memoryByPid.get(pid) ?? 0,
          active: pw.state.activeId === tab.id
        });
      }
    }
    const entries = raw.map((e) => ({
      ...e,
      shared: tabsPerPid.get(e.pid) ?? 1
    }));
    return { entries: rankTabMemory(entries), totalBytes: totalDistinctMemory(entries) };
  }
  /** Discard a tab by its globally-unique id, in whichever open profile window
   * owns it (tab ids are UUIDs, so at most one window matches). Backs the
   * `discard-tab` command; the Tabs settings panel spans profiles, so the owning
   * window is not necessarily the focused one. Runs the normal discard on it. */
  discardTabAnywhere(tabId) {
    for (const pw of this.openById.values()) {
      if (pw.state.tabs.some((t) => t.id === tabId)) return this.discardTabIn(pw, tabId);
    }
    throw new Error(`unknown tab: ${tabId}`);
  }
  focusedId() {
    return this.findByWindow(electron.BrowserWindow.getFocusedWindow())?.id ?? null;
  }
  findByWindow(window) {
    if (!window) return null;
    for (const pw of this.openById.values()) {
      if (pw.window === window) return pw;
    }
    return null;
  }
  // --- Multi-window-per-profile resolution ---
  // A profile can have several windows open at once (a torn-off tab, see
  // detach-tab). These helpers replace the old `openById.get(profileId)` (which
  // assumed one window per profile) everywhere a profile's window(s) are needed.
  /** Every open, live window of a profile (0, 1, or several). */
  windowsForProfile(profileId) {
    const out = [];
    for (const pw of this.openById.values()) {
      if (pw.id === profileId && !pw.window.isDestroyed()) out.push(pw);
    }
    return out;
  }
  /** A single window to target for a profile: the focused one when it belongs to
   * this profile (so a scripted action hits the window the user is looking at),
   * else the first open one, else null. */
  aWindowForProfile(profileId) {
    const focused = this.findByWindow(electron.BrowserWindow.getFocusedWindow());
    if (focused && focused.id === profileId && !focused.window.isDestroyed()) return focused;
    return this.windowsForProfile(profileId)[0] ?? null;
  }
  /** Send an IPC message to the chrome of EVERY open window of a profile. Replaces
   * the old single-window push for per-profile state (favorites, permissions,
   * rename, theme), which must now reach all of the profile's windows. */
  broadcastToProfile(profileId, channel, ...args) {
    for (const pw of this.windowsForProfile(profileId)) {
      pw.window.webContents.send(channel, ...args);
    }
  }
  /** The window currently hosting `tabId` (its tab is in that window's strip), or
   * null. Resolved LIVE against the strips so a tab's own event handlers (wired
   * once in materializeTab) follow it across a detach/attach without re-wiring —
   * the single source of truth is which window's state holds the tab. */
  ownerOf(tabId) {
    for (const pw of this.openById.values()) {
      if (pw.state.tabs.some((t) => t.id === tabId)) return pw;
    }
    return null;
  }
  /** The window currently hosting the view whose webContents is `wc`, or null.
   * Same purpose as ownerOf but keyed by the live webContents (for handlers that
   * only have the wc, e.g. shortcuts / context menu). A chrome webContents matches
   * no tab view, so callers fall back to the window they were wired against. */
  ownerByWebContents(wc) {
    for (const pw of this.openById.values()) {
      for (const view of pw.views.values()) {
        if (view.webContents === wc) return pw;
      }
    }
    return null;
  }
  // --- Persisted-session helpers (a profile maps to a LIST of windows) ---
  /** The saved windows of a profile (empty when none). */
  savedWindows(profileId) {
    return this.sessions[profileId] ?? [];
  }
  /** The saved entry correlated to a live window (by windowId), or undefined. */
  savedEntry(pw) {
    return this.savedWindows(pw.id).find((w) => w.windowId === pw.windowId);
  }
  /** Insert or replace a live window's snapshot in its profile's saved list,
   * matched by windowId (so a save updates in place, never appends a duplicate). */
  upsertSession(pw, entry) {
    const arr = this.sessions[pw.id] ? [...this.sessions[pw.id]] : [];
    const i = arr.findIndex((w) => w.windowId === pw.windowId);
    if (i >= 0) arr[i] = entry;
    else arr.push(entry);
    this.sessions[pw.id] = arr;
  }
  /** Forget a window's saved entry entirely (used when the user closes one of a
   * profile's several windows — a torn-off window they explicitly dismissed should
   * not reopen). Drops the profile key when it leaves no windows. */
  removeSessionEntry(pw) {
    const arr = this.sessions[pw.id];
    if (!arr) return;
    const next = arr.filter((w) => w.windowId !== pw.windowId);
    if (next.length > 0) this.sessions[pw.id] = next;
    else delete this.sessions[pw.id];
  }
  /** Context bound to the window that owns `sender` (the chrome that sent IPC). */
  contextForChrome(sender) {
    return this.makeContext(this.findByWindow(electron.BrowserWindow.fromWebContents(sender)));
  }
  /** Context bound to the focused window (external socket/MCP). Falls back to
   * any open window so a request still lands somewhere sensible. */
  contextForFocused() {
    const target = this.findByWindow(electron.BrowserWindow.getFocusedWindow()) ?? this.openById.values().next().value ?? null;
    return this.makeContext(target);
  }
  makeContext(target) {
    const activeWebContents = () => {
      if (!target || target.window.isDestroyed()) throw new Error("no target window");
      const activeId = target.state.activeId;
      if (!activeId || activeId === target.settingsTabId) throw new Error("no active web page");
      const view = target.views.get(activeId);
      if (!view) throw new Error("no active web page");
      return view.webContents;
    };
    const profileData = () => {
      if (!target) throw new Error("no target window");
      return this.dataFor(target.id);
    };
    const bookmarks = () => {
      if (!target) throw new Error("no target window");
      return this.bookmarksFor(target.id);
    };
    return {
      getTargetWebContents: () => {
        if (!target || target.window.isDestroyed()) {
          throw new Error("no target window");
        }
        const activeId = target.state.activeId;
        if (activeId && activeId === target.settingsTabId) {
          return {
            loadURL: () => {
            },
            goBack: () => {
            },
            goForward: () => {
            },
            reload: () => {
            },
            reloadIgnoringCache: () => {
            },
            getZoomLevel: () => 0,
            setZoomLevel: () => {
            }
          };
        }
        const view = activeId ? target.views.get(activeId) : void 0;
        if (!view) throw new Error("no active tab");
        const wc = view.webContents;
        return {
          loadURL: (url2) => wc.loadURL(url2),
          goBack: () => {
            if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
          },
          goForward: () => {
            if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
          },
          reload: () => wc.reload(),
          reloadIgnoringCache: () => wc.reloadIgnoringCache(),
          getZoomLevel: () => wc.getZoomLevel(),
          setZoomLevel: (level) => wc.setZoomLevel(level)
        };
      },
      getTargetProfile: () => {
        if (!target) return null;
        const profile = findById(this.profiles, target.id);
        if (!profile) return null;
        return this.toProfileInfo(profile);
      },
      // Magnifier slice — the native edge of the persistent optical zoom. The
      // active web tab is the target; the pure math lives in magnifier.ts.
      magnifierTarget: () => {
        if (!target || target.window.isDestroyed()) return null;
        const activeId = target.state.activeId;
        if (!activeId || activeId === target.settingsTabId) return null;
        const view = target.views.get(activeId);
        if (!view) return null;
        const b = view.getBounds();
        return { id: activeId, width: b.width, height: b.height };
      },
      getMagnifierState: (id) => this.magnifierStates.get(id) ?? NO_MAGNIFIER,
      setMagnifierState: (id, s) => {
        if (isMagnified(s)) this.magnifierStates.set(id, s);
        else this.magnifierStates.delete(id);
      },
      applyMagnifierClip: (id) => {
        if (target) this.applyMagnifier(target, id);
      },
      magnifierFlash: (id) => {
        const view = target?.views.get(id);
        if (view) evalInWebContents(view.webContents, MAGNIFIER_FLASH).catch(() => {
        });
      },
      focusApp: () => {
        if (target && !target.window.isDestroyed()) {
          if (target.window.isMinimized()) target.window.restore();
          target.window.show();
          target.window.focus();
        } else {
          this.openProfile(DEFAULT_PROFILE_ID);
        }
        electron.app.focus({ steal: true });
      },
      // Default-browser handoff: openUrl does its OWN targeting (an explicit
      // profileId, else the last-focused profile), independent of this context's
      // target window — the command may arrive over the socket while a different
      // window is "focused".
      openExternalUrl: (url2, profileId) => this.openUrl(url2, profileId),
      openProfile: (id) => this.openProfile(id),
      closeProfile: (id) => this.closeProfile(id),
      createProfile: (label) => this.createProfile(label),
      renameProfile: (id, label) => this.renameProfile(id, label),
      setProfileColor: (id, color) => this.setProfileColor(id, color),
      listProfiles: () => this.listProfiles(),
      listThemes: () => this.listThemes(),
      createTheme: (input) => this.createTheme(input),
      updateTheme: (id, patch) => this.updateTheme(id, patch),
      deleteTheme: (id) => this.deleteTheme(id),
      setProfileTheme: (id, themeId) => this.setProfileTheme(id, themeId),
      openSettings: (section) => {
        if (!target || target.window.isDestroyed()) throw new Error("no target window");
        this.openSettingsTabIn(target, section);
      },
      getSettings: () => ({ ...this.appSettings }),
      setHomeUrl: (url2) => {
        this.appSettings = withHomeUrl(this.appSettings, url2);
        this.deps.persistSettings(this.appSettings);
        return { ...this.appSettings };
      },
      setLlmConfig: (llm) => {
        this.appSettings = withLlm(this.appSettings, llm);
        this.deps.persistSettings(this.appSettings);
        return { ...this.appSettings };
      },
      setSidebarWidth: (width) => {
        this.appSettings = withSidebarWidth(this.appSettings, width);
        this.applyPanelWidths();
        return { ...this.appSettings };
      },
      setSkillPaneWidth: (width) => {
        this.appSettings = withSkillPaneWidth(this.appSettings, width);
        this.applyPanelWidths();
        return { ...this.appSettings };
      },
      cookieJarForProfile: (id) => {
        if (!findById(this.profiles, id)) throw new Error(`unknown profile: ${id}`);
        const sess = this.sessionFor(id);
        return sess.cookies;
      },
      countActiveSiteCookies: async () => {
        if (!target || target.window.isDestroyed()) return { url: null, count: 0 };
        const activeId = target.state.activeId;
        if (!activeId || activeId === target.settingsTabId) return { url: null, count: 0 };
        const view = target.views.get(activeId);
        if (!view) return { url: null, count: 0 };
        const wc = view.webContents;
        const url2 = wc.getURL();
        if (!/^https?:/.test(url2)) return { url: url2 || null, count: 0 };
        const cookies = await wc.session.cookies.get({ url: url2 });
        return { url: url2, count: cookies.length };
      },
      clearProfileData: async (profileId) => {
        const id = profileId ?? target?.id;
        if (!id) throw new Error("no target profile");
        if (!findById(this.profiles, id)) throw new Error(`unknown profile: ${id}`);
        const sess = this.sessionFor(id);
        await sess.clearCache();
        await sess.clearStorageData();
        return { id };
      },
      clearSiteData: async (targetUrl) => {
        let url2 = targetUrl;
        let sess;
        if (url2) {
          sess = this.sessionFor(target?.id ?? DEFAULT_PROFILE_ID);
        } else {
          if (!target || target.window.isDestroyed()) return null;
          const activeId = target.state.activeId;
          if (!activeId || activeId === target.settingsTabId) return null;
          const view = target.views.get(activeId);
          if (!view) return null;
          url2 = view.webContents.getURL();
          sess = view.webContents.session;
        }
        if (!/^https?:/.test(url2)) return null;
        const parsed = new URL(url2);
        const cookies = await sess.cookies.get({ url: url2 });
        for (const c of cookies) {
          const host = c.domain.replace(/^\./, "");
          await sess.cookies.remove(`${c.secure ? "https" : "http"}://${host}${c.path}`, c.name);
        }
        await sess.clearStorageData({
          origin: parsed.origin,
          storages: [
            "filesystem",
            "indexdb",
            "localstorage",
            "shadercache",
            "websql",
            "serviceworkers",
            "cachestorage"
          ]
        });
        return { host: parsed.host, cookiesRemoved: cookies.length };
      },
      getSpacesState: () => {
        const displays = spacesLayout();
        let windowLocation = null;
        if (target && !target.window.isDestroyed()) {
          const wid = parseWindowNumber(target.window.getMediaSourceId());
          if (wid !== void 0) {
            windowLocation = windowSpaceLocation(displays, windowSpaces(wid)) ?? null;
          }
        }
        return { displays, window: windowLocation };
      },
      moveTargetWindowToSpace: (spaceIndex) => {
        if (!target || target.window.isDestroyed()) throw new Error("no target window");
        const layout = spacesLayout();
        if (layout.length === 0) throw new Error("Spaces unavailable on this system");
        const wid = parseWindowNumber(target.window.getMediaSourceId());
        if (wid === void 0) throw new Error("window has no window-server id");
        const displayId = electron.screen.getDisplayMatching(target.window.getBounds()).id;
        const display = layout.find((d) => d.displayId === displayId) ?? layout[0];
        const desktops = userSpaceIds(display);
        if (spaceIndex >= desktops.length) {
          throw new Error(`no desktop at index ${spaceIndex} (display has ${desktops.length})`);
        }
        const where = windowSpaceLocation(layout, windowSpaces(wid));
        if (where && where.displayId === display.displayId && where.spaceIndex === spaceIndex) {
          return "noop";
        }
        if (!moveWindowToSpace(wid, desktops[spaceIndex])) {
          throw new Error("window server refused the move");
        }
        this.saveSession(target);
        const saved = this.savedEntry(target);
        if (saved?.bounds) saved.bounds.spaceIndex = spaceIndex;
        return "moved";
      },
      getMemoryUsage: () => this.deps.getMemoryUsage(),
      // Cross-profile: independent of `target`, walks every open window.
      listTabMemory: () => this.listTabMemory(),
      getTabCounts: () => {
        if (!target) return { total: 0, loaded: 0, asleep: 0 };
        const total = target.state.tabs.length;
        const loaded = target.views.size;
        return { total, loaded, asleep: total - loaded };
      },
      collectMedia: async (tabId) => {
        const { wc, buffer } = this.resolveMediaTab(target, tabId);
        const raw = await evalInWebContents(wc, MEDIA_COLLECT_SOURCE);
        const dom = parseDomMedia(raw);
        const network = buffer ? buffer.list() : [];
        return mergeMedia([...dom, ...network]);
      },
      downloadMedia: async (urls, tabId) => {
        const { wc } = this.resolveMediaTab(target, tabId);
        const dir = electron.app.getPath("downloads");
        const used = /* @__PURE__ */ new Set();
        let saved = 0;
        const failed = [];
        for (const url2 of urls) {
          try {
            await this.saveMediaUrl(wc, url2, dir, used);
            saved++;
          } catch (error) {
            console.error(`[mira] download-media failed for ${url2}`, error);
            failed.push(url2);
          }
        }
        return { saved, failed };
      },
      downloadVideoUrl: async (url2) => {
        return this.downloadVideoUrl(url2);
      },
      getMediaStats: () => {
        const base = target ? captureStats(target.media.values()) : { count: 0, bytes: 0 };
        return { ...base, downloads: [...this.activeDownloads.values()] };
      },
      setMediaGalleryOpen: (open) => {
        if (!target || target.window.isDestroyed()) throw new Error("no target window");
        return this.setMediaGalleryOpenIn(target, open);
      },
      // Downloads slice: the tracker is app-wide (a download outlives its window),
      // so these ignore `target` and address downloads by their minted id.
      listDownloads: () => this.downloadTracker.list(),
      cancelDownload: (id) => {
        const item = this.downloadItems.get(id);
        if (!item) return false;
        item.cancel();
        return true;
      },
      openDownload: async (id) => {
        const record = this.downloadTracker.get(id);
        if (!record || record.state !== "completed" || !node_fs.existsSync(record.savePath)) return false;
        return await electron.shell.openPath(record.savePath) === "";
      },
      revealDownload: (id) => {
        const record = this.downloadTracker.get(id);
        if (!record || !node_fs.existsSync(record.savePath)) return false;
        electron.shell.showItemInFolder(record.savePath);
        return true;
      },
      clearDownloads: () => this.downloadTracker.clearInactive(),
      getDownloadStats: () => this.downloadTracker.stats(),
      openFindBar: () => {
        activeWebContents();
        if (!target || target.window.isDestroyed()) return;
        target.window.webContents.focus();
        target.window.webContents.send("mira:find-open");
      },
      findInPage: (text, forward, newSession) => {
        const wc = activeWebContents();
        if (target) target.findText = text;
        wc.findInPage(text, { forward, findNext: newSession });
      },
      findStep: (forward) => {
        if (!target || target.findText === "") return false;
        const wc = activeWebContents();
        wc.findInPage(target.findText, { forward, findNext: false });
        return true;
      },
      stopFindInPage: (action) => {
        if (target) target.findText = "";
        try {
          activeWebContents().stopFindInPage(action);
        } catch {
        }
      },
      showTooltip: (text, anchor) => {
        if (!target || target.window.isDestroyed()) throw new Error("no target window");
        void showTooltip(target, text, anchor);
        return { shown: true };
      },
      hideTooltip: () => {
        if (target) hideTooltip(target);
        return { hidden: true };
      },
      showToast: (message) => {
        if (!target || target.window.isDestroyed()) throw new Error("no target window");
        void showToast(target, message);
      },
      execJsInTab: async (code, tabId) => {
        if (tabId) {
          for (const pw of this.openById.values()) {
            if (pw.window.isDestroyed()) continue;
            const view2 = pw.views.get(tabId);
            if (view2) return evalInWebContents(view2.webContents, code);
            if (tabId === pw.settingsTabId) throw new Error("not a web page (Settings tab)");
            if (pw.state.tabs.some((t) => t.id === tabId)) {
              throw new Error(`tab is asleep: ${tabId}`);
            }
          }
          throw new Error(`unknown tab: ${tabId}`);
        }
        if (!target || target.window.isDestroyed()) throw new Error("no target window");
        const activeId = target.state.activeId;
        if (!activeId || activeId === target.settingsTabId) {
          throw new Error("no active web page");
        }
        const view = target.views.get(activeId);
        if (!view) throw new Error("no active tab");
        return evalInWebContents(view.webContents, code);
      },
      pressKeyInTab: async (key, tabId, modifiers) => {
        const wc = this.webContentsForTab(target, tabId);
        const id = tabId ?? target?.state.activeId ?? void 0;
        const visible = await this.ensurePageVisibleForInput(wc, id);
        if (!visible) throw new Error("tab could not be made visible for input");
        const events = keyToDispatchEvents(key, modifiers);
        const dbg = wc.debugger;
        const wasAttached = dbg.isAttached();
        if (!wasAttached) dbg.attach("1.3");
        try {
          for (const ev of events) await dbg.sendCommand("Input.dispatchKeyEvent", ev);
        } finally {
          if (!wasAttached) dbg.detach();
        }
      },
      toggleDevToolsInActiveTab: () => {
        if (!target || target.window.isDestroyed()) throw new Error("no target window");
        return this.toggleActiveDevTools(target);
      },
      inspectCookiesInActiveTab: () => {
        if (!target || target.window.isDestroyed()) throw new Error("no target window");
        return this.inspectCookiesInActive(target);
      },
      activeUrl: () => {
        if (!target || target.window.isDestroyed()) return null;
        const activeId = target.state.activeId;
        if (!activeId || activeId === target.settingsTabId) return null;
        const view = target.views.get(activeId);
        if (!view) return null;
        return view.webContents.getURL() || null;
      },
      extractText: async (source) => {
        if (!target || target.window.isDestroyed()) throw new Error("no target window");
        const activeId = target.state.activeId;
        if (!activeId || activeId === target.settingsTabId) throw new Error("no active web page");
        const view = target.views.get(activeId);
        if (!view) throw new Error("no active tab");
        const text = await view.webContents.executeJavaScript(extractionScript(source), true);
        return typeof text === "string" ? text : String(text ?? "");
      },
      capturePage: async () => {
        if (!target || target.window.isDestroyed()) return null;
        const activeId = target.state.activeId;
        if (!activeId || activeId === target.settingsTabId) return null;
        const view = target.views.get(activeId);
        if (!view) return null;
        const image = await view.webContents.capturePage();
        if (image.isEmpty()) return null;
        return image.toDataURL();
      },
      summarize: async (prompt, text) => {
        return this.llm.run(this.appSettings.llm, prompt, text);
      },
      chat: async (messages, page) => {
        return this.llm.chat(this.appSettings.llm, messages, page);
      },
      showSkillPane: (state) => {
        if (target) this.setSkillPaneIn(target, state);
      },
      closeSkillPane: () => {
        if (target) this.setSkillPaneIn(target, { ...target.skillPane, open: false });
      },
      getSkillPane: () => target ? target.skillPane : closedSkillPane(),
      writeClipboard: (text) => electron.clipboard.writeText(text),
      newTab: (url2, background = false) => {
        if (!target || target.window.isDestroyed()) throw new Error("no target window");
        const tab = this.newTabIn(
          target,
          url2 ?? this.appSettings.homeUrl,
          !background,
          void 0,
          background
        );
        return {
          ...tab,
          loaded: true,
          kind: "web",
          pinned: false,
          keepAwake: false,
          folderId: null,
          audible: false
        };
      },
      closeTab: (id) => {
        if (!target) throw new Error("no target window");
        return this.closeTabIn(target, id);
      },
      closeActiveTab: () => {
        if (!target) throw new Error("no target window");
        return this.closeActiveTabIn(target);
      },
      duplicateActiveTab: () => {
        if (!target) throw new Error("no target window");
        return this.duplicateActiveTabIn(target);
      },
      // Resolve by the tab's globally-unique id across every open window, not just
      // the focused one — so the Tabs settings panel (cross-profile) can sleep any
      // listed tab, and a socket caller need not target the right window first.
      discardTab: (id) => this.discardTabAnywhere(id),
      discardActiveTab: () => {
        if (!target) throw new Error("no target window");
        return this.discardActiveTabIn(target);
      },
      wakeAllTabs: () => {
        if (!target) throw new Error("no target window");
        return this.wakeAllTabsIn(target);
      },
      moveTab: (id, toIndex) => {
        if (!target) throw new Error("no target window");
        return this.moveTabIn(target, id, toIndex);
      },
      // Tear a tab off the target window into another window of the same profile:
      // onto an existing window under the drop point, or a fresh one there. The tab
      // is resolved in the target window (the chrome that owns the sidebar drag).
      detachTab: (id, point) => {
        if (!target) throw new Error("no target window");
        const src = this.ownerOf(id) ?? target;
        return this.detachTabTo(src, id, point);
      },
      moveTabToWindow: (id, windowId) => this.moveTabToWindowById(id, windowId),
      activateTab: (id) => this.activateTabById(id),
      listWindows: () => this.listOpenWindows(),
      pinTab: (id) => {
        if (!target) throw new Error("no target window");
        return this.setTabPinnedIn(target, id, true);
      },
      unpinTab: (id) => {
        if (!target) throw new Error("no target window");
        return this.setTabPinnedIn(target, id, false);
      },
      setTabKeepAwake: (id, keepAwake) => {
        if (!target) throw new Error("no target window");
        return this.setTabKeepAwakeIn(target, id, keepAwake);
      },
      selectTab: (id) => {
        if (!target) throw new Error("no target window");
        return this.selectTabIn(target, id);
      },
      selectPrevTab: () => {
        if (!target) throw new Error("no target window");
        return this.selectAdjacentTabIn(target, -1);
      },
      selectNextTab: () => {
        if (!target) throw new Error("no target window");
        return this.selectAdjacentTabIn(target, 1);
      },
      recentTabBack: () => {
        if (!target) throw new Error("no target window");
        return this.stepMruIn(target, -1);
      },
      recentTabForward: () => {
        if (!target) throw new Error("no target window");
        return this.stepMruIn(target, 1);
      },
      listTabs: () => {
        if (!target) return { tabs: [], activeId: null, panelCollapsed: false };
        return {
          tabs: this.tabInfos(target),
          activeId: target.state.activeId,
          panelCollapsed: target.panelCollapsed
        };
      },
      toggleTabsPanel: (collapsed) => {
        if (!target) throw new Error("no target window");
        return this.toggleTabsPanelIn(target, collapsed);
      },
      showTabMenu: (tabId) => {
        if (!target) throw new Error("no target window");
        this.showTabMenuIn(target, tabId);
      },
      showAudioMenu: () => {
        if (!target) throw new Error("no target window");
        this.showAudioMenuIn(target);
      },
      listTabFolders: () => ({ folders: target ? target.folders : [] }),
      createTabFolder: (title, tabId) => {
        if (!target) throw new Error("no target window");
        return this.createTabFolderIn(target, title, tabId);
      },
      renameTabFolder: (id, title) => {
        if (!target) throw new Error("no target window");
        return this.renameTabFolderIn(target, id, title);
      },
      removeTabFolder: (id) => {
        if (!target) throw new Error("no target window");
        return this.removeTabFolderIn(target, id);
      },
      toggleTabFolder: (id, collapsed) => {
        if (!target) throw new Error("no target window");
        return this.toggleTabFolderIn(target, id, collapsed);
      },
      setTabFolderColor: (id, color) => {
        if (!target) throw new Error("no target window");
        return this.setTabFolderColorIn(target, id, color);
      },
      moveTabToFolder: (tabId, folderId) => {
        if (!target) throw new Error("no target window");
        return this.moveTabToFolderIn(target, tabId, folderId);
      },
      showFolderMenu: (folderId) => {
        if (!target) throw new Error("no target window");
        this.showFolderMenuIn(target, folderId);
      },
      toggleZen: (hidden) => {
        if (!target) throw new Error("no target window");
        return this.toggleZenIn(target, hidden);
      },
      setPaletteOpen: (open, mode, query) => {
        if (!target) throw new Error("no target window");
        return this.setPaletteOpenIn(target, open, mode, query);
      },
      reopenClosedTab: () => {
        if (!target) throw new Error("no target window");
        return this.reopenClosedTabIn(target);
      },
      listHistory: (limit) => profileData().listHistory(limit),
      searchHistory: (query, limit) => profileData().searchHistory(query, limit),
      clearHistory: () => profileData().clearHistory(),
      listPermissions: () => profileData().listPermissions(),
      clearPermissions: () => profileData().clearPermissions(),
      openLocationSettings: () => this.openLocationSettings(),
      locationAuthStatus: () => locationAuthStatus(),
      requestLocationAuthorization: () => requestLocationAuthorization(),
      addBookmark: (url2, title, parentId) => this.addBookmarkIn(target, url2, title, parentId),
      addFolder: (title, parentId) => bookmarks().addFolder(title, parentId),
      removeBookmark: (id) => bookmarks().remove(id),
      renameBookmark: (id, title) => bookmarks().rename(id, title),
      moveBookmark: (id, parentId, index) => bookmarks().move(id, parentId, index),
      listBookmarks: () => ({ tree: bookmarks().get() }),
      openBookmark: (id) => this.openBookmarkIn(target, id),
      // Vault (encrypted profile): the commands take an explicit id, so they don't
      // depend on the target window.
      encryptProfile: (id, password) => this.encryptProfileVault(id, password),
      unlockProfile: (id, password) => this.unlockProfileVault(id, password),
      lockProfile: (id) => this.lockProfileVault(id),
      lockAllVaults: () => this.lockAllVaults(),
      listVaults: () => this.listVaultsState(),
      // Extensions act on the TARGET window's profile session — sets are per
      // profile (D2): installing in "Work" leaves "Default" untouched.
      listExtensions: () => {
        if (!target) throw new Error("no target window");
        return this.deps.extensions.list(this.sessionFor(target.id), target.id);
      },
      loadExtension: (path2) => {
        if (!target) throw new Error("no target window");
        return this.deps.extensions.load(this.sessionFor(target.id), target.id, path2);
      },
      installExtension: (id) => {
        if (!target) throw new Error("no target window");
        return this.deps.extensions.installFromStore(this.sessionFor(target.id), target.id, id);
      },
      updateExtensions: () => {
        if (!target) throw new Error("no target window");
        return this.deps.extensions.update(this.sessionFor(target.id), target.id);
      },
      disableExtension: (id) => {
        if (!target) throw new Error("no target window");
        return Promise.resolve(
          this.deps.extensions.disable(this.sessionFor(target.id), target.id, id)
        );
      },
      enableExtension: (id) => {
        if (!target) throw new Error("no target window");
        return this.deps.extensions.enable(this.sessionFor(target.id), target.id, id);
      },
      uninstallExtension: (id) => {
        if (!target) throw new Error("no target window");
        return this.deps.extensions.uninstall(this.sessionFor(target.id), target.id, id);
      },
      readServiceWorkerConsole: (query) => {
        const profileId = query.profileId ?? target?.id;
        if (!profileId) throw new Error("no target window");
        return this.deps.extensions.serviceWorkerConsole(this.sessionFor(profileId), query);
      }
    };
  }
}
const SERVICE_WORKER_BRIDGE_PORT = "__mira_extension_service_worker_bridge_v1__";
const SERVICE_WORKER_BRIDGE_SW_MAIN_WORLD = `() => {
  const g = globalThis;
  if (!g.chrome || !g.chrome.runtime || !g.chrome.runtime.onConnect ||
      typeof g.chrome.runtime.onConnect.addListener !== 'function' ||
      typeof g.MessageChannel !== 'function' || typeof g.MessageEvent !== 'function') return;
  if (g.__miraExtensionSwBridgeInstalled) return;
  Object.defineProperty(g, '__miraExtensionSwBridgeInstalled', { value: true });
  const PORT_NAME = ${JSON.stringify(SERVICE_WORKER_BRIDGE_PORT)};
  g.chrome.runtime.onConnect.addListener((runtimePort) => {
    if (!runtimePort || runtimePort.name !== PORT_NAME) return;
    let opened = false;
    const localPorts = [];
    const close = () => {
      for (const port of localPorts) { try { port.close(); } catch (_) {} }
      localPorts.length = 0;
    };
    if (runtimePort.onDisconnect && runtimePort.onDisconnect.addListener) {
      runtimePort.onDisconnect.addListener(close);
    }
    runtimePort.onMessage.addListener((envelope) => {
      if (!envelope || typeof envelope !== 'object') return;
      if (!opened && envelope.kind === 'open') {
        opened = true;
        const count = Number.isInteger(envelope.portCount) && envelope.portCount > 0
          ? envelope.portCount : 0;
        const transferred = [];
        for (let index = 0; index < count; index += 1) {
          const channel = new g.MessageChannel();
          const relayPort = channel.port1;
          relayPort.onmessage = (event) => {
            try { runtimePort.postMessage({ kind: 'port-message', index, data: event.data }); }
            catch (_) { close(); }
          };
          if (relayPort.start) relayPort.start();
          localPorts.push(relayPort);
          transferred.push(channel.port2);
        }
        g.dispatchEvent(new g.MessageEvent('message', {
          data: envelope.data,
          ports: transferred,
          origin: g.location && g.location.origin ? g.location.origin : ''
        }));
        return;
      }
      if (opened && envelope.kind === 'port-message' &&
          Number.isInteger(envelope.index) && localPorts[envelope.index]) {
        localPorts[envelope.index].postMessage(envelope.data);
      }
    });
  });
}`;
const SERVICE_WORKER_BRIDGE_FRAME_MAIN_WORLD = `() => {
  const g = globalThis;
  if (!g.location || !g.location.href.startsWith('chrome-extension://') ||
      !g.navigator || !g.navigator.serviceWorker ||
      !g.chrome || !g.chrome.runtime || typeof g.chrome.runtime.connect !== 'function') return;
  try { if (g.top === g) return; } catch (_) { /* a cross-origin top means nested */ }
  const container = g.navigator.serviceWorker;
  if (container.controller || container.__miraBridgeInstalled) return;
  const PORT_NAME = ${JSON.stringify(SERVICE_WORKER_BRIDGE_PORT)};
  const active = {
    state: 'activated',
    scriptURL: '',
    postMessage(data, transferOrOptions) {
      const transferred = Array.isArray(transferOrOptions)
        ? transferOrOptions
        : transferOrOptions && Array.isArray(transferOrOptions.transfer)
          ? transferOrOptions.transfer : [];
      const messagePorts = transferred.filter((value) =>
        value && typeof value.postMessage === 'function');
      const runtimePort = g.chrome.runtime.connect({ name: PORT_NAME });
      const close = () => {
        for (const port of messagePorts) { try { port.close(); } catch (_) {} }
      };
      runtimePort.onMessage.addListener((envelope) => {
        if (!envelope || envelope.kind !== 'port-message' ||
            !Number.isInteger(envelope.index) || !messagePorts[envelope.index]) return;
        messagePorts[envelope.index].postMessage(envelope.data);
      });
      if (runtimePort.onDisconnect && runtimePort.onDisconnect.addListener) {
        runtimePort.onDisconnect.addListener(close);
      }
      messagePorts.forEach((port, index) => {
        port.onmessage = (event) => {
          try { runtimePort.postMessage({ kind: 'port-message', index, data: event.data }); }
          catch (_) { close(); }
        };
        if (port.start) port.start();
      });
      runtimePort.postMessage({ kind: 'open', data, portCount: messagePorts.length });
    }
  };
  const registration = {
    active,
    installing: null,
    waiting: null,
    scope: g.location.origin + '/',
    update: () => Promise.resolve(),
    unregister: () => Promise.resolve(false)
  };
  try {
    Object.defineProperty(container, '__miraBridgeInstalled', { value: true });
    Object.defineProperty(container, 'ready', {
      configurable: true,
      get: () => Promise.resolve(registration)
    });
  } catch (_) { /* leave the native container untouched if it is not patchable */ }
}`;
const SERVICE_WORKER_BRIDGE_FRAME_SOURCE = `(() => {
  if (typeof process === 'undefined' || process.type !== 'renderer' ||
      !location.href.startsWith('chrome-extension://')) return;
  const install = ${SERVICE_WORKER_BRIDGE_FRAME_MAIN_WORLD};
  try {
    const { contextBridge } = require('electron');
    if (contextBridge && typeof contextBridge.executeInMainWorld === 'function') {
      contextBridge.executeInMainWorld({ func: install });
      return;
    }
  } catch (_) {}
  install();
})();`;
const OFFSCREEN_IPC_CHANNEL = "mira-extension-offscreen";
const CHOOSE_DESKTOP_MEDIA_IPC_CHANNEL = "mira-extension-choose-desktop-media";
const BEGIN_TAB_CAPTURE_IPC_CHANNEL = "mira-extension-begin-tab-capture";
const OFFSCREEN_SHIM_MAIN_WORLD = `(bridge) => {
  const g = globalThis;
  if (!g.chrome || !g.chrome.runtime || !bridge) return;
  if (!g.chrome.runtime.ContextType && typeof g.chrome.runtime.getContexts === 'function') {
    try {
      g.chrome.runtime.ContextType = Object.freeze({
        TAB: 'TAB', POPUP: 'POPUP', BACKGROUND: 'BACKGROUND',
        OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT', SIDE_PANEL: 'SIDE_PANEL',
        DEVELOPER_TOOLS: 'DEVELOPER_TOOLS'
      });
    } catch (_) { /* frozen runtime — the getContexts caller copes */ }
  }
  if (g.chrome.offscreen) return; // native API present — do nothing
  const settle = (promise, callback) => {
    if (typeof callback !== 'function') return promise;
    promise.then((value) => callback(value), () => callback(undefined));
    return undefined;
  };
  g.chrome.offscreen = {
    Reason: Object.freeze({
      TESTING: 'TESTING', AUDIO_PLAYBACK: 'AUDIO_PLAYBACK', IFRAME_SCRIPTING: 'IFRAME_SCRIPTING',
      DOM_SCRAPING: 'DOM_SCRAPING', BLOBS: 'BLOBS', DOM_PARSER: 'DOM_PARSER',
      USER_MEDIA: 'USER_MEDIA', DISPLAY_MEDIA: 'DISPLAY_MEDIA', WEB_RTC: 'WEB_RTC',
      CLIPBOARD: 'CLIPBOARD', LOCAL_STORAGE: 'LOCAL_STORAGE', WORKERS: 'WORKERS',
      BATTERY_STATUS: 'BATTERY_STATUS', MATCH_MEDIA: 'MATCH_MEDIA', GEOLOCATION: 'GEOLOCATION'
    }),
    createDocument(parameters, callback) {
      const url = parameters && typeof parameters.url === 'string' ? parameters.url : '';
      const done = url
        ? Promise.resolve(bridge.create(url)).then((r) => {
            if (!r || !r.ok) throw new Error(r && r.error ? r.error : 'offscreen document failed');
          })
        : Promise.reject(new TypeError('createDocument requires a url'));
      return settle(done, callback);
    },
    closeDocument(callback) {
      return settle(Promise.resolve(bridge.close()).then(() => undefined), callback);
    },
    hasDocument(callback) {
      return settle(Promise.resolve(bridge.has()).then((r) => !!(r && r.exists)), callback);
    }
  };
}`;
const OFFSCREEN_SHIM_SOURCE = `(() => {
  if (typeof process === 'undefined' || process.type !== 'service-worker') return;
  let electron;
  try { electron = require('electron'); } catch (_) { return; }
  const { contextBridge, ipcRenderer } = electron;
  if (!ipcRenderer) return;
  const CHANNEL = ${JSON.stringify(OFFSCREEN_IPC_CHANNEL)};
  const bridge = {
    create: (url) => ipcRenderer.invoke(CHANNEL, { op: 'create', url }),
    close: () => ipcRenderer.invoke(CHANNEL, { op: 'close' }),
    has: () => ipcRenderer.invoke(CHANNEL, { op: 'has' })
  };
  const install = ${OFFSCREEN_SHIM_MAIN_WORLD};
  try {
    if (contextBridge && typeof contextBridge.executeInMainWorld === 'function') {
      contextBridge.executeInMainWorld({ func: install, args: [bridge] });
      return;
    }
  } catch (_) { /* fall through */ }
  install(bridge);
})();`;
const CAPTURE_SHIM_MAIN_WORLD = `(bridge) => {
  const g = globalThis;
  if (!g.chrome || !g.chrome.runtime || !bridge) return;
  const withLastError = (message, fn) => {
    let assigned = false;
    try { g.chrome.runtime.lastError = { message }; assigned = true; } catch (_) {}
    try { fn(); } finally {
      if (assigned) { try { delete g.chrome.runtime.lastError; } catch (_) {} }
    }
  };
  if (!g.chrome.desktopCapture) {
    let seq = 0;
    const cancelled = new Set();
    g.chrome.desktopCapture = {
      chooseDesktopMedia(sources, targetTabOrCallback, maybeCallback) {
        const callback = typeof targetTabOrCallback === 'function' ? targetTabOrCallback : maybeCallback;
        const requestId = ++seq;
        const wanted = Array.isArray(sources) ? sources.filter((s) => typeof s === 'string') : [];
        Promise.resolve(bridge.chooseDesktopMedia(wanted)).then((result) => {
          if (cancelled.delete(requestId) || typeof callback !== 'function') return;
          const streamId = result && typeof result.streamId === 'string' ? result.streamId : '';
          if (streamId) callback(streamId, { canRequestAudioTrack: false });
          else withLastError('No desktop media source available', () => callback('', { canRequestAudioTrack: false }));
        }, () => {
          if (cancelled.delete(requestId) || typeof callback !== 'function') return;
          withLastError('Desktop capture failed', () => callback('', { canRequestAudioTrack: false }));
        });
        return requestId;
      },
      cancelChooseDesktopMedia(requestId) { cancelled.add(requestId); }
    };
  }
  if (!g.chrome.tabCapture) {
    g.chrome.tabCapture = {
      capture(options, callback) {
        const opts = options || {};
        const wantAudio = opts.audio !== false;
        const wantVideo = opts.video !== false;
        Promise.resolve(bridge.beginTabCapture({ audio: wantAudio, video: wantVideo }))
          .then((armed) => {
            if (!armed || !armed.ok) {
              throw new Error(armed && armed.error ? armed.error : 'tab capture unavailable');
            }
            // getDisplayMedia rejects audio-only requests; always ask for video
            // and drop the track below when the caller did not want it.
            return g.navigator.mediaDevices.getDisplayMedia({ video: true, audio: wantAudio });
          })
          .then((stream) => {
            if (!wantVideo) {
              for (const track of stream.getVideoTracks()) { track.stop(); stream.removeTrack(track); }
            }
            if (typeof callback === 'function') callback(stream);
          })
          .catch((error) => {
            const message = error && error.message ? String(error.message) : String(error);
            if (typeof callback === 'function') withLastError(message, () => callback(null));
          });
      },
      getCapturedTabs(callback) {
        if (typeof callback === 'function') callback([]);
        return Promise.resolve([]);
      }
    };
  }
}`;
const CAPTURE_SHIM_FRAME_SOURCE = `(() => {
  if (typeof process === 'undefined' || process.type !== 'renderer' ||
      !location.href.startsWith('chrome-extension://')) return;
  let electron;
  try { electron = require('electron'); } catch (_) { return; }
  const { contextBridge, ipcRenderer } = electron;
  if (!ipcRenderer) return;
  const bridge = {
    chooseDesktopMedia: (sources) =>
      ipcRenderer.invoke(${JSON.stringify(CHOOSE_DESKTOP_MEDIA_IPC_CHANNEL)}, { sources }),
    beginTabCapture: (options) =>
      ipcRenderer.invoke(${JSON.stringify(BEGIN_TAB_CAPTURE_IPC_CHANNEL)}, options)
  };
  const install = ${CAPTURE_SHIM_MAIN_WORLD};
  try {
    if (contextBridge && typeof contextBridge.executeInMainWorld === 'function') {
      contextBridge.executeInMainWorld({ func: install, args: [bridge] });
      return;
    }
  } catch (_) { /* fall through */ }
  install(bridge);
})();`;
const ALARM_MIN_DELAY_MS = 3e4;
const ALARMS_POLYFILL_MAIN_WORLD = `() => {
  const g = globalThis;
  // Only inside an extension context (real chrome.runtime): this also runs in
  // plain web service workers, which must not gain a fake chrome.
  if (!g.chrome || !g.chrome.runtime) return;
  if (g.chrome.alarms) return; // real API present — do nothing
  const MIN = ${ALARM_MIN_DELAY_MS};
  const KEY = '__mira_alarms__';
  const timers = new Map();       // name -> timeout/interval id
  const alarms = new Map();       // name -> { name, scheduledTime, periodInMinutes }
  const listeners = new Set();
  const store = () => (g.chrome.storage && g.chrome.storage.local) || null;
  const persist = () => { const s = store(); if (s) s.set({ [KEY]: [...alarms.values()] }); };
  const delayMs = (info) => {
    if (info && typeof info.when === 'number') return Math.max(0, info.when - Date.now());
    const m = info && typeof info.delayInMinutes === 'number' ? info.delayInMinutes
      : info && typeof info.periodInMinutes === 'number' ? info.periodInMinutes : 0;
    return Math.max(MIN, Math.round(m * 60000));
  };
  const fire = (name) => {
    const a = alarms.get(name); if (!a) return;
    for (const cb of listeners) { try { cb(a); } catch (e) { /* swallow */ } }
    if (typeof a.periodInMinutes !== 'number') { alarms.delete(name); timers.delete(name); persist(); }
  };
  const clearTimer = (name) => {
    const t = timers.get(name);
    if (t) { clearTimeout(t); clearInterval(t); timers.delete(name); }
  };
  g.chrome.alarms = {
    create(name, info) {
      if (typeof name === 'object') { info = name; name = ''; }
      info = info || {};
      clearTimer(name);
      const period = typeof info.periodInMinutes === 'number'
        ? Math.max(MIN, Math.round(info.periodInMinutes * 60000)) : null;
      const first = delayMs(info);
      alarms.set(name, {
        name,
        scheduledTime: Date.now() + first,
        ...(typeof info.periodInMinutes === 'number' ? { periodInMinutes: info.periodInMinutes } : {})
      });
      persist();
      timers.set(name, setTimeout(() => {
        fire(name);
        if (period != null) timers.set(name, setInterval(() => fire(name), period));
      }, first));
    },
    get(name, cb) { const a = alarms.get(name) || null; if (cb) cb(a); return Promise.resolve(a); },
    getAll(cb) { const all = [...alarms.values()]; if (cb) cb(all); return Promise.resolve(all); },
    clear(name, cb) { clearTimer(name); const had = alarms.delete(name); persist(); if (cb) cb(had); return Promise.resolve(had); },
    clearAll(cb) { for (const n of [...timers.keys()]) clearTimer(n); alarms.clear(); persist(); if (cb) cb(true); return Promise.resolve(true); },
    onAlarm: {
      addListener(cb) { listeners.add(cb); },
      removeListener(cb) { listeners.delete(cb); },
      hasListener(cb) { return listeners.has(cb); }
    }
  };
}`;
const ALARMS_POLYFILL_SOURCE = `(() => {
  if (typeof process === 'undefined' || process.type !== 'service-worker') return;
  // Beacon: one line per SW (re)evaluation, logged in the MAIN world (where SW
  // console output is captured in the chromium log — the preload realm's may not
  // be). Correlate with the [mira-sw] lifecycle logs in the main log to see a
  // worker being killed/restarted under an in-flight, stateful flow (e.g. a
  // password manager holding a login session in memory). Temporary diagnostics —
  // remove once the SW-liveness question is settled.
  const beacon = () => {
    try { console.log('[mira-sw] evaluated ' + (self.location && self.location.href)); } catch (_) {}
  };
  const installBridge = ${SERVICE_WORKER_BRIDGE_SW_MAIN_WORLD};
  const polyfill = ${ALARMS_POLYFILL_MAIN_WORLD};
  try {
    const { contextBridge } = require('electron');
    if (contextBridge && typeof contextBridge.executeInMainWorld === 'function') {
      contextBridge.executeInMainWorld({ func: beacon });
      contextBridge.executeInMainWorld({ func: installBridge });
      contextBridge.executeInMainWorld({ func: polyfill });
      return;
    }
  } catch (_) { /* not a preload realm with the electron module — fall through */ }
  // Context isolation off: the preload world IS the main world.
  beacon();
  installBridge();
  polyfill();
})();`;
const WORKER_RESTART_WINDOW_MS = 6e4;
const WORKER_RESTART_MAX = 5;
function recordWorkerRestart(history, nowMs) {
  const recent = history.filter((t) => nowMs - t < WORKER_RESTART_WINDOW_MS);
  if (recent.length >= WORKER_RESTART_MAX) return { allowed: false, history: recent };
  return { allowed: true, history: [...recent, nowMs] };
}
function stripUnsupportedPermissions(manifest) {
  const isFatal = (p) => typeof p === "string" && (p.startsWith("declarativeNetRequest") || p === "offscreen");
  const out = { ...manifest };
  let changed = false;
  for (const key of ["permissions", "optional_permissions"]) {
    const perms = out[key];
    if (Array.isArray(perms) && perms.some(isFatal)) {
      out[key] = perms.filter((p) => !isFatal(p));
      changed = true;
    }
  }
  if ("declarative_net_request" in out) {
    delete out.declarative_net_request;
    changed = true;
  }
  return changed ? { changed, manifest: out } : { changed: false, manifest };
}
const lower = (s) => typeof s === "string" ? s.toLowerCase() : "";
function translateDnrRules(rules) {
  const out = [];
  for (const rule of rules) {
    const cond = rule.condition ?? {};
    const resourceTypesRaw = Array.isArray(cond.resourceTypes) ? cond.resourceTypes : Array.isArray(cond.resourceType) ? cond.resourceType : typeof cond.resourceType === "string" ? [cond.resourceType] : [];
    const hasResourceConstraint = "resourceTypes" in cond || "resourceType" in cond || "excludedResourceTypes" in cond;
    const base = {
      ruleId: typeof rule.id === "number" ? rule.id : 0,
      priority: typeof rule.priority === "number" ? rule.priority : 1,
      urlFilter: typeof cond.urlFilter === "string" ? cond.urlFilter : void 0,
      regexFilter: typeof cond.regexFilter === "string" ? cond.regexFilter : void 0,
      caseSensitive: cond.isUrlFilterCaseSensitive === true,
      methods: (cond.requestMethods ?? []).map(lower).filter(Boolean),
      resourceTypes: resourceTypesRaw.map(lower).filter(Boolean),
      // Chrome excludes top-level navigations when neither resource include nor
      // exclude list is present. Never broaden a translated rule to main_frame.
      excludedResourceTypes: hasResourceConstraint ? (cond.excludedResourceTypes ?? []).map(lower).filter(Boolean) : ["main_frame"],
      domains: (cond.requestDomains ?? []).map(lower).filter(Boolean),
      removeRequestHeaders: [],
      setRequestHeaders: [],
      removeResponseHeaders: [],
      setResponseHeaders: []
    };
    const supportedConditionKeys = /* @__PURE__ */ new Set([
      "urlFilter",
      "regexFilter",
      "isUrlFilterCaseSensitive",
      "requestMethods",
      "resourceTypes",
      "resourceType",
      // Kondo compatibility alias
      "excludedResourceTypes",
      "requestDomains"
    ]);
    const unsupportedConditionKeys = Object.keys(cond).filter(
      (key) => !supportedConditionKeys.has(key)
    );
    if (unsupportedConditionKeys.length > 0) {
      out.push({
        ...base,
        action: "unsupported",
        unsupportedReason: `condition field(s) not translatable: ${unsupportedConditionKeys.join(", ")}`
      });
      continue;
    }
    const type = lower(rule.action?.type);
    if (type === "block") {
      out.push({ ...base, action: "block" });
    } else if (type === "allow" || type === "allowallrequests") {
      out.push({ ...base, action: "allow" });
    } else if (type === "redirect") {
      const url2 = rule.action?.redirect?.url;
      if (typeof url2 === "string" && url2) {
        out.push({ ...base, action: "redirect", redirectUrl: url2 });
      } else {
        out.push({
          ...base,
          action: "unsupported",
          unsupportedReason: "redirect without a static url (regexSubstitution/extensionPath/transform)"
        });
      }
    } else if (type === "modifyheaders") {
      const mod = { ...base, action: "modifyHeaders" };
      for (const h of rule.action?.requestHeaders ?? []) {
        const name = lower(h.header);
        if (!name) continue;
        if (lower(h.operation) === "remove") mod.removeRequestHeaders.push(name);
        else if (lower(h.operation) === "set" && typeof h.value === "string")
          mod.setRequestHeaders.push({ name, value: h.value });
      }
      for (const h of rule.action?.responseHeaders ?? []) {
        const name = lower(h.header);
        if (!name) continue;
        if (lower(h.operation) === "remove") mod.removeResponseHeaders.push(name);
        else if (lower(h.operation) === "set" && typeof h.value === "string")
          mod.setResponseHeaders.push({ name, value: h.value });
      }
      out.push(mod);
    } else {
      out.push({
        ...base,
        action: "unsupported",
        unsupportedReason: `action "${type || "(none)"}" not translatable to webRequest`
      });
    }
  }
  return out;
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function dnrUrlFilterToRegExp(urlFilter, caseSensitive = false) {
  let f = urlFilter;
  let prefix = "";
  let suffix = "";
  if (f.startsWith("||")) {
    prefix = "^[a-z]+://([^/]*\\.)?";
    f = f.slice(2);
  } else if (f.startsWith("|")) {
    prefix = "^";
    f = f.slice(1);
  }
  if (f.endsWith("|")) {
    suffix = "$";
    f = f.slice(0, -1);
  }
  let body = "";
  for (const ch of f) {
    if (ch === "*") body += ".*";
    else if (ch === "^") body += "[^a-zA-Z0-9_\\-.%]";
    else body += escapeRe(ch);
  }
  return new RegExp(prefix + body + suffix, caseSensitive ? "" : "i");
}
const RESOURCE_TYPE_ALIASES = {
  xhr: "xmlhttprequest",
  mainframe: "main_frame",
  subframe: "sub_frame",
  cspreport: "csp_report"
};
function dnrMatches(mod, req) {
  const method = lower(req.method);
  if (mod.methods.length && !mod.methods.includes(method)) return false;
  const rt = RESOURCE_TYPE_ALIASES[lower(req.resourceType)] ?? lower(req.resourceType);
  if (mod.resourceTypes.length && !mod.resourceTypes.includes(rt)) return false;
  if (mod.excludedResourceTypes.includes(rt)) return false;
  if (mod.domains.length) {
    let host = "";
    try {
      host = new URL(req.url).hostname.toLowerCase();
    } catch {
      return false;
    }
    const inDomain = mod.domains.some((d) => host === d || host.endsWith("." + d));
    if (!inDomain) return false;
  }
  if (mod.regexFilter) {
    try {
      if (!new RegExp(mod.regexFilter, mod.caseSensitive ? "" : "i").test(req.url)) return false;
    } catch {
      return false;
    }
  } else if (mod.urlFilter) {
    if (!dnrUrlFilterToRegExp(mod.urlFilter, mod.caseSensitive).test(req.url)) return false;
  }
  return true;
}
const RELAXED_POLICY_FEATURES = [
  "camera",
  "microphone",
  "display-capture"
];
function relaxPermissionsPolicy(value, origins) {
  if (!origins.length || !value) return value;
  const quoted = origins.map((o) => `"${o}"`).join(" ");
  return value.split(",").map((segment) => {
    const match = /^(\s*)([a-zA-Z-]+)\s*=\s*(.*?)(\s*)$/.exec(segment);
    if (!match) return segment;
    const [, lead, feature, allowlist, trail] = match;
    if (!RELAXED_POLICY_FEATURES.includes(feature.toLowerCase())) return segment;
    if (allowlist === "*") return segment;
    let relaxed;
    if (allowlist.startsWith("(") && allowlist.endsWith(")")) {
      const inner = allowlist.slice(1, -1).trim();
      relaxed = inner ? `(${inner} ${quoted})` : `(${quoted})`;
    } else {
      relaxed = allowlist ? `(${allowlist} ${quoted})` : `(${quoted})`;
    }
    return `${lead}${feature}=${relaxed}${trail}`;
  }).join(",");
}
const KNOWN_LIMITATIONS = {
  declarativeNetRequest: {
    severity: "degraded",
    note: "no native DNR in Electron — Mira translates the ruleset to session.webRequest (block/allow/redirect/modifyHeaders only)"
  },
  declarativeNetRequestWithHostAccess: {
    severity: "degraded",
    note: "no native DNR in Electron — Mira translates the ruleset to session.webRequest (block/allow/redirect/modifyHeaders only)"
  },
  declarativeNetRequestFeedback: {
    severity: "degraded",
    note: "DNR feedback/matched-rules API not provided"
  },
  webRequest: {
    severity: "degraded",
    note: "chrome.webRequest is unavailable inside MV3 service workers on Electron (electron#52265)"
  },
  webRequestBlocking: {
    severity: "degraded",
    note: "blocking webRequest unavailable in MV3 service workers on Electron"
  },
  identity: {
    severity: "breaking",
    note: "chrome.identity (OAuth) not implemented by Electron or the lib"
  },
  sidePanel: { severity: "degraded", note: "chrome.sidePanel not implemented" },
  tabGroups: { severity: "degraded", note: "chrome.tabGroups not implemented" },
  commands: {
    severity: "degraded",
    note: "chrome.commands is stubbed — extension keyboard shortcuts are inert"
  },
  offscreen: {
    severity: "info",
    note: "chrome.offscreen is shimmed by Mira (hidden host window) — the native Electron implementation would crash the browser on media access"
  },
  desktopCapture: {
    severity: "info",
    note: "chrome.desktopCapture is shimmed — Mira draws its own source picker (screens + windows) and returns the chosen id; no system audio track"
  },
  tabCapture: {
    severity: "info",
    note: "chrome.tabCapture is shimmed via display-media capture of the active tab (video + tab audio)"
  },
  debugger: { severity: "breaking", note: "chrome.debugger not implemented" },
  declarativeContent: { severity: "degraded", note: "chrome.declarativeContent not implemented" }
};
function asStringArray(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}
function detectCapabilityGaps(manifest) {
  const perms = [
    ...asStringArray(manifest.permissions),
    ...asStringArray(manifest.optional_permissions)
  ];
  const byApi = /* @__PURE__ */ new Map();
  for (const p of perms) {
    const limit = KNOWN_LIMITATIONS[p];
    if (limit) byApi.set(p, { api: p, severity: limit.severity, note: limit.note });
  }
  if (manifest.declarative_net_request && !byApi.has("declarativeNetRequest")) {
    const limit = KNOWN_LIMITATIONS.declarativeNetRequest;
    byApi.set("declarativeNetRequest", {
      api: "declarativeNetRequest",
      severity: limit.severity,
      note: limit.note
    });
  }
  const order = { breaking: 0, degraded: 1, info: 2 };
  return [...byApi.values()].sort((a, b) => order[a.severity] - order[b.severity]);
}
function pickerKind(id) {
  return id.startsWith("screen:") ? "screen" : "window";
}
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const PICKER_CHOOSE_CHANNEL = "mira:desktop-picker:choose";
const PICKER_PRELOAD_SOURCE = `const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('miraPicker', {
  choose: (id) => ipcRenderer.send(${JSON.stringify(PICKER_CHOOSE_CHANNEL)}, String(id || '')),
})
`;
function renderPickerHtml(sources) {
  const screens = sources.filter((s) => s.kind === "screen");
  const windows = sources.filter((s) => s.kind === "window");
  const card = (s) => {
    const thumb = s.thumbnail ? `<img class="thumb" src="${s.thumbnail}" alt="" draggable="false" />` : `<div class="thumb thumb-empty"></div>`;
    const icon2 = s.appIcon ? `<img class="app-icon" src="${s.appIcon}" alt="" />` : "";
    return `<button class="card" type="button" onclick="miraPicker.choose('${escapeHtml(s.id)}')" title="${escapeHtml(s.name)}">
      ${thumb}
      <span class="label">${icon2}<span class="name">${escapeHtml(s.name)}</span></span>
    </button>`;
  };
  const group = (title, items) => items.length ? `<h2 class="group-title">${title}</h2><div class="grid">${items.map(card).join("")}</div>` : "";
  const empty = sources.length ? "" : `<p class="empty">No screen or window is available to share. Check Screen Recording permission in System Settings &rsaquo; Privacy &amp; Security.</p>`;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font: 13px -apple-system, system-ui, sans-serif;
    background: #1e1e1e; color: #e8e8e8; user-select: none;
    display: flex; flex-direction: column; height: 100vh;
  }
  header { padding: 16px 20px 8px; }
  header h1 { margin: 0; font-size: 15px; font-weight: 600; }
  main { flex: 1; overflow-y: auto; padding: 8px 20px 16px; }
  .group-title { font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
    color: #9a9a9a; margin: 16px 0 8px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
  .card { background: #2a2a2a; border: 1px solid transparent; border-radius: 8px;
    padding: 8px; cursor: pointer; color: inherit; text-align: left; font: inherit;
    display: flex; flex-direction: column; gap: 8px; transition: border-color .1s, background .1s; }
  .card:hover { background: #333; border-color: #4c8bf5; }
  .card:focus-visible { outline: 2px solid #4c8bf5; outline-offset: 1px; }
  .thumb { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 4px;
    background: #111; display: block; }
  .thumb-empty { background: repeating-linear-gradient(45deg, #222, #222 6px, #262626 6px, #262626 12px); }
  .label { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .app-icon { width: 16px; height: 16px; flex: 0 0 auto; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { color: #9a9a9a; line-height: 1.5; }
  footer { padding: 12px 20px; border-top: 1px solid #333; display: flex; justify-content: flex-end; }
  .cancel { background: #3a3a3a; color: #e8e8e8; border: none; border-radius: 6px;
    padding: 7px 16px; font: inherit; cursor: pointer; }
  .cancel:hover { background: #454545; }
</style>
</head>
<body>
  <header><h1>Choose what to share</h1></header>
  <main>${group("Screens", screens)}${group("Windows", windows)}${empty}</main>
  <footer><button class="cancel" type="button" onclick="miraPicker.choose('')">Cancel</button></footer>
  <script>
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') miraPicker.choose(''); });
  <\/script>
</body>
</html>`;
}
function showDesktopSourcePicker(sources, opts) {
  const win = new electron.BrowserWindow({
    parent: opts.parent ?? void 0,
    modal: opts.parent != null,
    width: 780,
    height: 580,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Choose what to share",
    backgroundColor: "#1e1e1e",
    show: false,
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.setMenuBarVisibility(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      if (!win.isDestroyed()) win.close();
    };
    win.webContents.ipc.on(PICKER_CHOOSE_CHANNEL, (_event, id) => {
      finish(id ? id : null);
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.once("ready-to-show", () => win.show());
    win.on("closed", () => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    });
    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(renderPickerHtml(sources))).catch(() => finish(null));
  });
}
function desktopSourceTypes(wanted) {
  const types = /* @__PURE__ */ new Set();
  for (const source of wanted) {
    if (source === "screen") types.add("screen");
    if (source === "window") types.add("window");
  }
  return types.size ? [...types] : ["screen", "window"];
}
const TAB_CAPTURE_ARM_TTL_MS = 1e4;
function armFrame(pending, frameKey2, nowMs) {
  pending.set(frameKey2, nowMs + TAB_CAPTURE_ARM_TTL_MS);
}
function consumeArmedFrame(pending, frameKey2, nowMs) {
  const deadline = pending.get(frameKey2);
  if (deadline === void 0) return false;
  pending.delete(frameKey2);
  return nowMs <= deadline;
}
class ExtensionCaptureService {
  constructor(userDataDir) {
    this.userDataDir = userDataDir;
  }
  userDataDir;
  /** Armed tab-capture requests, keyed by frame (processId:routingId). */
  pendingTabCapture = /* @__PURE__ */ new Map();
  /** Sessions whose display-media handler + preload are installed. */
  attached = /* @__PURE__ */ new WeakSet();
  /** Global ipcMain handlers installed once. */
  ipcInstalled = false;
  /** On-disk frame preload, written once. */
  shimPath = null;
  /** On-disk picker-window preload, written once. */
  pickerPreloadPath = null;
  /** True while a desktop-source picker is open, so a second chooseDesktopMedia
   * cannot stack a second modal. */
  pickerOpen = false;
  /** Wire the capture shims into `ses`. Must run BEFORE the extensions lib
   * registers its preloads (same Object.freeze(chrome) ordering constraint as
   * every main-world shim). Idempotent per session; best-effort. */
  attach(ses, hooks) {
    if (this.attached.has(ses)) return;
    this.attached.add(ses);
    try {
      this.registerPreload(ses);
    } catch (error) {
      console.warn("[mira] failed to register capture shim preload:", error);
    }
    this.installIpc();
    ses.setDisplayMediaRequestHandler((request, callback) => {
      const frame = request.frame;
      const armed = frame !== null && consumeArmedFrame(
        this.pendingTabCapture,
        frameKey(frame.processId, frame.routingId),
        Date.now()
      );
      const target = armed ? hooks.activeTab() : null;
      if (target && !target.isDestroyed()) {
        callback({ video: target.mainFrame, audio: target.mainFrame, enableLocalEcho: true });
        return;
      }
      void this.chooseDesktopForPage(callback);
    });
  }
  /** The two page->main channels, once per app (ipcMain is global). Senders
   * are validated to extension pages — a web page invoking these channels gets
   * an error, not a capture. */
  installIpc() {
    if (this.ipcInstalled) return;
    this.ipcInstalled = true;
    electron.ipcMain.handle(
      CHOOSE_DESKTOP_MEDIA_IPC_CHANNEL,
      async (event, payload) => {
        if (!isExtensionSender(event)) return { streamId: "" };
        const wanted = Array.isArray(payload?.sources) ? payload.sources.filter((s) => typeof s === "string") : [];
        if (this.pickerOpen) return { streamId: "" };
        try {
          const sources = await electron.desktopCapturer.getSources({
            types: desktopSourceTypes(wanted),
            thumbnailSize: { width: 320, height: 180 },
            fetchWindowIcons: true
          });
          const streamId = await this.chooseSource(sources);
          if (!streamId)
            console.warn("[mira-capture] no desktop source chosen (cancelled or none available)");
          return { streamId };
        } catch (error) {
          console.warn("[mira-capture] getSources failed:", error);
          return { streamId: "" };
        }
      }
    );
    electron.ipcMain.handle(BEGIN_TAB_CAPTURE_IPC_CHANNEL, (event) => {
      if (!isExtensionSender(event)) return { ok: false, error: "not an extension page" };
      const frame = event.senderFrame;
      if (!frame) return { ok: false, error: "no sender frame" };
      armFrame(this.pendingTabCapture, frameKey(frame.processId, frame.routingId), Date.now());
      return { ok: true };
    });
  }
  /** Backend for a plain web page's getDisplayMedia (Meet, Slack huddles…):
   * enumerate desktop sources, let the user pick one through Mira's own picker,
   * and resolve the request with the chosen screen/window. Cancel, an empty
   * source list, or a picker already up all resolve to a denied request
   * (callback({})) — the same outcome the page would get if it clicked Cancel in
   * Chrome. Video-only: system-audio loopback is not offered for screen shares
   * (Meet mixes mic audio itself). */
  async chooseDesktopForPage(callback) {
    if (this.pickerOpen) return callback({});
    try {
      const sources = await electron.desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: true
      });
      const streamId = await this.chooseSource(sources);
      const chosen = streamId ? sources.find((s) => s.id === streamId) : void 0;
      if (!chosen) {
        console.warn("[mira-capture] getDisplayMedia: no source chosen (cancelled or none)");
        return callback({});
      }
      callback({ video: chosen });
    } catch (error) {
      console.warn("[mira-capture] getDisplayMedia getSources failed:", error);
      callback({});
    }
  }
  /** Show the desktop-source picker for `sources` and resolve to the chosen
   * source id, or '' when the user cancels or nothing is available. Parents the
   * modal to the focused Mira window (the recorder page that triggered the
   * request lives there). */
  async chooseSource(sources) {
    if (!sources.length) return "";
    const picker = sources.map(toPickerSource);
    const parent = electron.BrowserWindow.getFocusedWindow();
    this.pickerOpen = true;
    try {
      const chosen = await showDesktopSourcePicker(picker, {
        parent,
        preloadPath: this.ensurePickerPreload()
      });
      return chosen ?? "";
    } finally {
      this.pickerOpen = false;
    }
  }
  /** Write the picker-window preload once (same on-disk pattern as the capture
   * frame shim) and return its path. */
  ensurePickerPreload() {
    if (this.pickerPreloadPath) return this.pickerPreloadPath;
    const dir = path.join(this.userDataDir, "sw-shims");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const path$1 = path.join(dir, "extension-capture-picker-preload.js");
    fs.writeFileSync(path$1, PICKER_PRELOAD_SOURCE, "utf8");
    this.pickerPreloadPath = path$1;
    return path$1;
  }
  /** Write the frame preload once and register it on the session. */
  registerPreload(ses) {
    if (!this.shimPath) {
      const dir = path.join(this.userDataDir, "sw-shims");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const path$1 = path.join(dir, "extension-capture-frame.js");
      fs.writeFileSync(path$1, CAPTURE_SHIM_FRAME_SOURCE, "utf8");
      this.shimPath = path$1;
    }
    ses.registerPreloadScript({
      id: "mira-extension-capture-frame",
      type: "frame",
      filePath: this.shimPath
    });
  }
}
function toPickerSource(source) {
  const appIcon = source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null;
  return {
    id: source.id,
    name: source.name || "Untitled",
    kind: pickerKind(source.id),
    thumbnail: source.thumbnail && !source.thumbnail.isEmpty() ? source.thumbnail.toDataURL() : "",
    appIcon
  };
}
function frameKey(processId, routingId) {
  return `${processId}:${routingId}`;
}
function isExtensionSender(event) {
  return event.senderFrame?.url?.startsWith("chrome-extension://") ?? false;
}
const EXECUTE_ACTION_COMMANDS = /* @__PURE__ */ new Set([
  "_execute_action",
  "_execute_browser_action",
  "_execute_page_action"
]);
function isExecuteActionCommand(name) {
  return EXECUTE_ACTION_COMMANDS.has(name);
}
const KEY_ALIASES = {
  comma: ",",
  period: ".",
  space: " ",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  ins: "Insert",
  insert: "Insert",
  del: "Delete",
  delete: "Delete",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  tab: "Tab"
};
function parseCommandShortcut(shortcut, platform) {
  if (typeof shortcut !== "string" || !shortcut) return null;
  const out = { key: "", meta: false, ctrl: false, shift: false, alt: false };
  for (const rawPart of shortcut.split("+")) {
    const part = rawPart.trim();
    const lower2 = part.toLowerCase();
    if (lower2 === "command" || lower2 === "cmd") out.meta = true;
    else if (lower2 === "macctrl") out.ctrl = true;
    else if (lower2 === "ctrl") {
      if (platform === "darwin") out.meta = true;
      else out.ctrl = true;
    } else if (lower2 === "alt" || lower2 === "option") out.alt = true;
    else if (lower2 === "shift") out.shift = true;
    else if (lower2 === "search")
      return null;
    else if (lower2.startsWith("media"))
      return null;
    else if (out.key)
      return null;
    else if (/^[a-z0-9]$/.test(lower2)) out.key = part.toUpperCase();
    else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower2)) out.key = part.toUpperCase();
    else if (KEY_ALIASES[lower2]) out.key = KEY_ALIASES[lower2];
    else return null;
  }
  if (!out.key) return null;
  return out;
}
function commandsFromManifest(manifest, platform) {
  const commands = manifest?.commands;
  if (!commands || typeof commands !== "object") return [];
  const platformKey = platform === "darwin" ? "mac" : platform === "win32" ? "windows" : platform === "linux" ? "linux" : platform;
  const out = [];
  for (const [name, details] of Object.entries(commands)) {
    const keys = details?.suggested_key;
    if (!keys || typeof keys !== "object") continue;
    const raw = keys[platformKey] ?? keys.default;
    if (typeof raw !== "string") continue;
    const shortcut = parseCommandShortcut(raw, platform);
    if (shortcut) out.push({ name, shortcut });
  }
  return out;
}
function inputMatches(shortcut, input) {
  if (input.type !== "keyDown") return false;
  if (input.meta !== shortcut.meta || input.control !== shortcut.ctrl || input.shift !== shortcut.shift || input.alt !== shortcut.alt) {
    return false;
  }
  return input.key.length === 1 ? input.key.toUpperCase() === shortcut.key.toUpperCase() : input.key === shortcut.key;
}
class ExtensionCommandsService {
  /** Commands per session per extension id, refreshed on load/unload. */
  bySession = /* @__PURE__ */ new Map();
  /** Dispatcher hooks per attached session. */
  hooks = /* @__PURE__ */ new Map();
  /** The app-level input hook is installed once. */
  inputHooked = false;
  /** Watch `ses`'s extensions and dispatch their shortcuts. Idempotent. */
  attach(ses, hooks) {
    if (this.bySession.has(ses)) return;
    const byExtension = /* @__PURE__ */ new Map();
    this.bySession.set(ses, byExtension);
    this.hooks.set(ses, hooks);
    const refresh = (id, manifest) => {
      const commands = commandsFromManifest(manifest, process.platform);
      if (commands.length) byExtension.set(id, commands);
      else byExtension.delete(id);
    };
    for (const ext of ses.extensions.getAllExtensions()) refresh(ext.id, ext.manifest);
    ses.extensions.on("extension-loaded", (_e, ext) => refresh(ext.id, ext.manifest));
    ses.extensions.on("extension-unloaded", (_e, ext) => byExtension.delete(ext.id));
    this.hookInput();
  }
  /** Listen on every webContents (present and future) — tabs, chrome, popups.
   * One listener per webContents; cheap (a map lookup per keyDown). */
  hookInput() {
    if (this.inputHooked) return;
    this.inputHooked = true;
    const wire = (wc) => {
      wc.on("before-input-event", (event, input) => {
        if (input.type !== "keyDown") return;
        const hit = this.match(wc, input);
        if (!hit) return;
        event.preventDefault();
        this.dispatch(hit.ses, hit.extensionId, hit.command);
      });
    };
    for (const wc of electron.webContents.getAllWebContents()) wire(wc);
    electron.app.on("web-contents-created", (_event, wc) => wire(wc));
  }
  /** The command matching `input` in the session owning `wc`, if any. A chrome
   * webContents runs on its own extension-free session, so it maps to the
   * profile session whose current window it belongs to. */
  match(wc, input) {
    const candidates = [];
    if (this.bySession.has(wc.session)) {
      candidates.push(wc.session);
    } else {
      for (const [ses, hooks] of this.hooks) {
        if (hooks.chromeWebContents() === wc) candidates.push(ses);
      }
    }
    for (const ses of candidates) {
      const byExtension = this.bySession.get(ses);
      if (!byExtension) continue;
      for (const [extensionId, commands] of byExtension) {
        for (const command of commands) {
          if (inputMatches(command.shortcut, input)) {
            return { ses, extensionId, command: command.name };
          }
        }
      }
    }
    return null;
  }
  /** Run one matched command. */
  dispatch(ses, extensionId, command) {
    const hooks = this.hooks.get(ses);
    if (!hooks) return;
    if (isExecuteActionCommand(command)) {
      this.clickAction(hooks.chromeWebContents(), extensionId);
      return;
    }
    hooks.sendCommand(extensionId, command);
  }
  /** Open an extension's popup by clicking its real toolbar button in the
   * chrome renderer — the <browser-action-list> element's shadow root is open
   * and its buttons carry the extension id. Same code path as a user click, so
   * the popup anchors to the button. */
  clickAction(chromeWc, extensionId) {
    if (!chromeWc || chromeWc.isDestroyed()) return;
    const code = `(() => {
      const list = document.querySelector('browser-action-list');
      const button = list && list.shadowRoot && list.shadowRoot.getElementById(${JSON.stringify(extensionId)});
      if (!button) return false;
      button.click();
      return true;
    })()`;
    chromeWc.executeJavaScript(code, true).then(
      (clicked) => {
        if (!clicked) {
          console.warn(`[mira-commands] no toolbar button found for ${extensionId}`);
        }
      },
      (error) => console.warn("[mira-commands] failed to activate action:", error)
    );
  }
}
function resolveOffscreenUrl(extensionId, requestedUrl) {
  if (!extensionId || typeof requestedUrl !== "string" || requestedUrl === "") return null;
  let resolved;
  try {
    resolved = new URL(requestedUrl, `chrome-extension://${extensionId}/`);
  } catch {
    return null;
  }
  if (resolved.protocol !== "chrome-extension:" || resolved.host !== extensionId) return null;
  return resolved.href;
}
function decideOffscreenRequest(request, extensionId, hasDocument) {
  switch (request?.op) {
    case "create": {
      if (hasDocument) return { verdict: "noop" };
      const url2 = resolveOffscreenUrl(extensionId, request.url ?? "");
      if (!url2) return { verdict: "error", error: "invalid offscreen document url" };
      return { verdict: "create", url: url2 };
    }
    case "close":
      return { verdict: "close" };
    case "has":
      return { verdict: "has" };
    default:
      return { verdict: "error", error: `unknown offscreen op: ${String(request?.op)}` };
  }
}
class OffscreenHostService {
  constructor(userDataDir) {
    this.userDataDir = userDataDir;
  }
  userDataDir;
  /** Hidden host window per session per extension id. */
  hosts = /* @__PURE__ */ new Map();
  /** Sessions already attached (preload + worker hook + unload hook). */
  attached = /* @__PURE__ */ new WeakSet();
  /** Workers whose offscreen ipc handler is installed. */
  hookedWorkers = /* @__PURE__ */ new WeakSet();
  /** On-disk preload source, written once. */
  shimPath = null;
  /** Wire the offscreen shim into `ses`. Must run BEFORE the extensions lib
   * registers its preloads on the session (ensureFor in extensions.ts calls it
   * that way) so the shim's chrome.offscreen lands before Object.freeze(chrome).
   * Idempotent per session; best-effort (a failure must not stop the extension
   * system from coming up). */
  attach(ses) {
    if (this.attached.has(ses)) return;
    this.attached.add(ses);
    try {
      this.registerPreload(ses);
    } catch (error) {
      console.warn("[mira] failed to register offscreen shim preload:", error);
    }
    ses.serviceWorkers.on("running-status-changed", ({ versionId }) => {
      let worker = null;
      try {
        worker = ses.serviceWorkers.getWorkerFromVersionID(versionId);
      } catch {
        return;
      }
      if (!worker?.scope?.startsWith("chrome-extension://") || this.hookedWorkers.has(worker)) {
        return;
      }
      this.hookedWorkers.add(worker);
      const extensionId = idFromScope$1(worker.scope);
      worker.ipc.handle(
        OFFSCREEN_IPC_CHANNEL,
        (_event, payload) => this.handle(ses, extensionId, payload)
      );
    });
    ses.extensions.on("extension-unloaded", (_event, extension) => {
      this.closeFor(ses, extension.id);
    });
  }
  /** Serve one shim call. Never throws (the shim maps {ok:false} to a rejected
   * createDocument promise, which is what extension code expects). */
  handle(ses, extensionId, request) {
    const decision = decideOffscreenRequest(
      request,
      extensionId,
      this.hostFor(ses, extensionId) !== null
    );
    switch (decision.verdict) {
      case "create":
        if (!ses.extensions.getExtension(extensionId)) {
          return { ok: false, error: `extension not loaded: ${extensionId}` };
        }
        try {
          this.createHost(ses, extensionId, decision.url);
          return { ok: true };
        } catch (error) {
          return { ok: false, error: String(error) };
        }
      case "noop":
        return { ok: true };
      case "close":
        this.closeFor(ses, extensionId);
        return { ok: true };
      case "has":
        return { ok: true, exists: this.hostFor(ses, extensionId) !== null };
      case "error":
        return { ok: false, error: decision.error };
    }
  }
  /** The live host window of an extension, or null. Prunes destroyed ones. */
  hostFor(ses, extensionId) {
    const byExtension = this.hosts.get(ses);
    const win = byExtension?.get(extensionId);
    if (win && !win.isDestroyed()) return win;
    byExtension?.delete(extensionId);
    return null;
  }
  /** Create the hidden host window and load the offscreen page in it. */
  createHost(ses, extensionId, url2) {
    const win = new electron.BrowserWindow({
      show: false,
      webPreferences: {
        session: ses,
        // The page hosts recording/device plumbing — never throttle its timers.
        backgroundThrottling: false
      }
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const byExtension = this.hosts.get(ses) ?? /* @__PURE__ */ new Map();
    this.hosts.set(ses, byExtension);
    byExtension.set(extensionId, win);
    win.on("closed", () => {
      const current = this.hosts.get(ses);
      if (current?.get(extensionId) === win) current.delete(extensionId);
    });
    console.log(`[mira-offscreen] hosting ${url2}`);
    void win.webContents.loadURL(url2).catch((error) => {
      console.warn(`[mira-offscreen] failed to load ${url2}:`, error);
    });
  }
  /** Close (destroy) an extension's host, if any. */
  closeFor(ses, extensionId) {
    const win = this.hostFor(ses, extensionId);
    if (win) win.destroy();
  }
  /** Write the SW preload once and register it on the session. */
  registerPreload(ses) {
    if (!this.shimPath) {
      const dir = path.join(this.userDataDir, "sw-shims");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const path$1 = path.join(dir, "offscreen.js");
      fs.writeFileSync(path$1, OFFSCREEN_SHIM_SOURCE, "utf8");
      this.shimPath = path$1;
    }
    ses.registerPreloadScript({
      id: "mira-offscreen-shim",
      type: "service-worker",
      filePath: this.shimPath
    });
  }
}
function idFromScope$1(scope) {
  return scope.replace(/^chrome-extension:\/\//, "").replace(/\/.*$/, "");
}
function normalizeSideloaded(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const result = {};
  for (const [profileId, paths] of Object.entries(raw)) {
    if (!Array.isArray(paths)) continue;
    const valid = paths.filter((p) => typeof p === "string" && p.trim() !== "");
    if (valid.length > 0) result[profileId] = valid;
  }
  return result;
}
function sideloadedFor(map, profileId) {
  return map[profileId] ?? [];
}
function addSideloaded(map, profileId, path2) {
  const existing = map[profileId] ?? [];
  if (existing.includes(path2)) return map;
  return { ...map, [profileId]: [...existing, path2] };
}
function normalizeDisabled(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const result = {};
  for (const [profileId, entries] of Object.entries(raw)) {
    if (!Array.isArray(entries)) continue;
    const valid = entries.filter(
      (e) => typeof e === "object" && e !== null && typeof e.id === "string" && e.id.trim() !== "" && typeof e.name === "string" && typeof e.version === "string" && typeof e.path === "string" && e.path.trim() !== ""
    );
    if (valid.length > 0) result[profileId] = valid;
  }
  return result;
}
function disabledFor(map, profileId) {
  return map[profileId] ?? [];
}
function addDisabled(map, profileId, ext) {
  const existing = map[profileId] ?? [];
  return { ...map, [profileId]: [...existing.filter((e) => e.id !== ext.id), ext] };
}
function removeDisabled(map, profileId, id) {
  const existing = map[profileId];
  if (!existing || !existing.some((e) => e.id === id)) return map;
  const remaining = existing.filter((e) => e.id !== id);
  const next = { ...map };
  if (remaining.length === 0) delete next[profileId];
  else next[profileId] = remaining;
  return next;
}
function removeSideloaded(map, profileId, path2) {
  const existing = map[profileId];
  if (!existing || !existing.includes(path2)) return map;
  const remaining = existing.filter((p) => p !== path2);
  const next = { ...map };
  if (remaining.length === 0) delete next[profileId];
  else next[profileId] = remaining;
  return next;
}
const ORIGINAL_MANIFEST_FILE = "manifest.mira-original.json";
class ExtensionsService {
  constructor(deps) {
    this.deps = deps;
    this.sideloaded = deps.initialSideloaded;
    this.disabled = deps.initialDisabled;
    electronChromeExtensions.setSessionPartitionResolver(
      (partition) => partition === DEFAULT_SESSION_ALIAS ? electron.session.defaultSession : electron.session.fromPartition(partition)
    );
  }
  deps;
  /** One lib instance per Session (see the file header for why the key is the
   * Session object itself). */
  bySession = /* @__PURE__ */ new Map();
  /** Sessions whose recorded sideloads have been loaded this run, so reopening
   * a profile window doesn't re-load (loadExtension would throw on a dup). */
  loadedSessions = /* @__PURE__ */ new Set();
  /** Sessions where Web Store support is already installed (same idempotence
   * story as loadedSessions — installChromeWebStore must run once per session). */
  webStoreSessions = /* @__PURE__ */ new Set();
  /** Extension ids approved through the in-page Chrome Web Store flow. The
   * dependency downloads and immediately loads those extensions, so this lets
   * the extension-loaded hook distinguish that path from our programmatic
   * install path and sanitize a fatal DNR manifest before reloading it. */
  pendingWebStoreInstalls = /* @__PURE__ */ new Map();
  /** Sessions carrying the extension-loaded hook for pending store installs. */
  webStoreInstallHooked = /* @__PURE__ */ new Set();
  /** Live registry of sideloaded paths per profile. Mirrors extensions.json. */
  sideloaded;
  /** Live registry of paused extensions per profile. Mirrors its json file. */
  disabled;
  /** Per-session declarativeNetRequest rules translated to webRequest mods
   * (extension-capabilities.ts, Tier B). Rebuilt from the live extension set on
   * every load/enable/update/uninstall; the installed handlers read it live. */
  dnrBySession = /* @__PURE__ */ new Map();
  /** Sessions where the webRequest handlers backing DNR are already installed
   * (only one listener per event per session — install once, update the map). */
  dnrHooked = /* @__PURE__ */ new Set();
  /** Path of the on-disk chrome.alarms polyfill (Tier A), written once and
   * registered as a service-worker preload per session. */
  alarmsShimPath = null;
  /** Path of the nested extension-frame half of the service-worker bridge. */
  workerBridgeFramePath = null;
  /** chrome.offscreen backend (hidden host windows) — lazy, needs userData. */
  offscreenHost = null;
  /** chrome.desktopCapture / chrome.tabCapture backend — lazy, needs userData. */
  captureService = null;
  /** Extension keyboard shortcuts (manifest `commands`). */
  commandsService = new ExtensionCommandsService();
  /** Create the extension system for `ses` if it doesn't exist yet. Must run
   * before any page loads in the session — the instance registers its preload
   * (frame + service-worker) on the session at construction. Idempotent. */
  ensureFor(ses, hooks) {
    if (this.bySession.has(ses)) return;
    this.registerRuntimeShims(ses);
    this.offscreenHost ??= new OffscreenHostService(electron.app.getPath("userData"));
    this.offscreenHost.attach(ses);
    this.captureService ??= new ExtensionCaptureService(electron.app.getPath("userData"));
    this.captureService.attach(ses, { activeTab: hooks.activeTab });
    this.commandsService.attach(ses, {
      chromeWebContents: hooks.chromeWebContents,
      sendCommand: (extensionId, command) => this.sendCommandEvent(ses, extensionId, command)
    });
    const instance = new electronChromeExtensions.ElectronChromeExtensions({
      // Decision D1 (extensions-plan.md §7): GPL-3.0 — free, requires providing
      // sources if Mira is ever distributed (it isn't).
      license: "GPL-3.0",
      session: ses,
      createTab: (details) => hooks.createTab({ url: details.url }),
      selectTab: (wc) => hooks.selectTab(wc),
      removeTab: (wc) => hooks.removeTab(wc),
      // A window = a profile normally, so extensions don't get to open profile
      // windows — but a few flows genuinely need a transient popOUT window that
      // hosts an extension page: Bitwarden's passkey/unlock picker (fido2) opens
      // one via chrome.windows.create, and without this hook the lib throws
      // "createWindow is not implemented", so the WebAuthn request hangs forever.
      // This creates a bare, session-bound BrowserWindow (like the lib's own
      // browser-action popup) that loads the extension URL — NOT a ProfileWindow.
      createWindow: (details) => this.createExtensionPopout(ses, details)
      // assignTabDetails omitted: the lib only sees materialized tabs, so
      // `discarded` would be constant.
    });
    this.bySession.set(ses, instance);
    this.hookWorkerKeepalive(ses);
  }
  /** Open a transient popout window hosting an extension page, for the lib's
   * chrome.windows.create hook. Mirrors the lib's own browser-action popup: a
   * bare, session-bound BrowserWindow that loads the extension URL, so the page
   * gets the extension's preload and chrome.* APIs. NOT a ProfileWindow — it's
   * unknown to ProfileManager on purpose (findByWindow returns null for it).
   * Used by Bitwarden's fido2 passkey/unlock picker. */
  async createExtensionPopout(ses, details) {
    const win = new electron.BrowserWindow({
      ...extensionPopoutBounds(details),
      show: false,
      // A titlebar so the user can always dismiss it; popout, not a full chrome.
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        enablePreferredSizeMode: true
      }
    });
    const url2 = Array.isArray(details.url) ? details.url[0] : details.url;
    if (url2) {
      try {
        await win.loadURL(url2);
      } catch (error) {
        console.warn("[mira] extension popout failed to load:", error);
      }
    }
    if (details.focused === false) win.showInactive();
    else win.show();
    return win;
  }
  /** Write the chrome.alarms polyfill to disk once and register it as a
   * service-worker preload on `ses` (Tier A). Electron has no chrome.alarms and
   * Kondo's SW touches it at the top level of its module — without the shim the
   * eval throws and Chromium marks the worker failed (extensions-plan.md §8.7).
   * Must be registered BEFORE the lib's preload (see ensureFor); the source
   * itself crosses into the SW main world via executeInMainWorld. Best-effort:
   * a failure here must not stop the extension system from coming up. */
  registerRuntimeShims(ses) {
    try {
      const dir = path.join(electron.app.getPath("userData"), "sw-shims");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (!this.alarmsShimPath) {
        const path$1 = path.join(dir, "alarms.js");
        fs.writeFileSync(path$1, ALARMS_POLYFILL_SOURCE, "utf8");
        this.alarmsShimPath = path$1;
      }
      if (!this.workerBridgeFramePath) {
        const path$1 = path.join(dir, "extension-sw-bridge-frame.js");
        fs.writeFileSync(path$1, SERVICE_WORKER_BRIDGE_FRAME_SOURCE, "utf8");
        this.workerBridgeFramePath = path$1;
      }
      ses.registerPreloadScript({
        id: "mira-alarms-shim",
        type: "service-worker",
        filePath: this.alarmsShimPath
      });
      ses.registerPreloadScript({
        id: "mira-extension-sw-bridge-frame",
        type: "frame",
        filePath: this.workerBridgeFramePath
      });
    } catch (error) {
      console.warn("[mira] failed to register extension runtime shims:", error);
    }
  }
  // --- Service-worker launch + keepalive (Electron 41 lifecycle gap) -------
  //
  // Electron 41 never starts an extension's MV3 service worker beyond the
  // launch where it was installed, and chrome.runtime.connect does not wake a
  // stopped worker (electron#41613; fixed in 42.x, 41 backport abandoned) —
  // the cause of Kondo's "Browser extension stopped" loop once the DNR crash
  // is out of the way (extensions-plan.md §8). Official workaround: start the
  // workers ourselves.
  //
  // Primary keepalive: ServiceWorkerMain.startTask() holds each running worker
  // alive so Chromium never idle-terminates it (its doc: "the service won't
  // terminate while otherwise idle"). This keeps the SAME worker resident with
  // its in-memory state intact — decisive for a stateful extension like a
  // password manager, whose unlocked vault key lives in SW memory. Without it,
  // the old restart-on-stop approach let Chromium kill the SW after ~30s and
  // then re-created it from a COLD eval: the vault re-locked every ~30s and any
  // in-flight popup->SW unlock message was dropped mid-request ("The message
  // port closed before a response was received"), so unlock never took.
  //
  // Fallback: we still restart on stop (a genuine crash can stop a held
  // worker), with a pure throttle (recordWorkerRestart) so a worker that
  // crashes at eval cannot restart-loop. Net effect: extension SWs stay
  // resident (acceptable RAM cost for a personal browser).
  /** versionId -> scope, per session: 'stopped' events carry only a versionId
   * whose info is no longer queryable, so remember scopes while they run. */
  workerScopes = /* @__PURE__ */ new Map();
  /** Ring buffer of extension-SW console output per session, tailed by the
   * extension-console command. Mira can't open devtools on a headless MV3
   * worker, so capturing its console is the only way to see it throw/log.
   * Mirrored to disk (swConsoleFile) so it survives a main-process reload — in
   * dev, every HMR restart would otherwise wipe it mid-debug. */
  swConsole = /* @__PURE__ */ new Map();
  /** versionId -> extension id, per session, NEVER pruned. Electron leaves the
   * sourceUrl empty on most SW logs (runtime.lastError, port-closed, …), so the
   * only way to attribute them is a durable id learned from an earlier message
   * or the worker's scope. Pruning on 'stopped' (like workerScopes) would lose
   * exactly the attribution we need. */
  swWorkerIds = /* @__PURE__ */ new Map();
  /** Resolved on-disk JSONL path per session for the SW console mirror. */
  swConsoleFile = /* @__PURE__ */ new Map();
  /** Monotonic sequence for captured SW log entries — lets a caller poll for
   * "what's new since seq N" even as old entries drop out of the buffer. Seeded
   * from disk on attach so it keeps climbing across reloads. */
  swConsoleSeq = 0;
  /** Restart history per session+scope, pruned by recordWorkerRestart. */
  workerRestarts = /* @__PURE__ */ new Map();
  /** Live keepalive task per session+versionId. Holding a StartTask is what
   * prevents idle termination; the handle is kept so it is not GC'd and can be
   * released when the worker version goes away. */
  workerTasks = /* @__PURE__ */ new Map();
  /** Start the SW of every loaded MV3 service-worker extension of `ses`.
   * Idempotent (startWorkerForScope is a no-op on a running worker); failures
   * are logged, never fatal. Called after every path that (re)loads
   * extensions. */
  launchWorkers(ses) {
    for (const ext of ses.extensions.getAllExtensions()) {
      const manifest = ext.manifest;
      if (manifest?.manifest_version !== 3 || !manifest.background?.service_worker) continue;
      console.log(`[mira-sw] launch ${ext.id}`);
      ses.serviceWorkers.startWorkerForScope(ext.url).catch((error) => {
        console.warn(`[mira] failed to start extension SW ${ext.id}:`, error);
      });
    }
  }
  /** Restart extension SWs of `ses` when they stop. Once per session. */
  hookWorkerKeepalive(ses) {
    if (this.workerScopes.has(ses)) return;
    const scopes = /* @__PURE__ */ new Map();
    this.workerScopes.set(ses, scopes);
    this.hookServiceWorkerConsole(ses, scopes);
    ses.serviceWorkers.on("running-status-changed", ({ versionId, runningStatus }) => {
      if (runningStatus === "starting" || runningStatus === "running") {
        try {
          const scope2 = ses.serviceWorkers.getInfoFromVersionID(versionId).scope;
          if (scope2.startsWith("chrome-extension://")) {
            scopes.set(versionId, scope2);
            this.rememberSwId(ses, versionId, extensionIdFromUrl(scope2));
            console.log(`[mira-sw] ${runningStatus} ${idFromScope(scope2)} (v${versionId})`);
            if (runningStatus === "running") this.holdWorkerAlive(ses, versionId, scope2);
          }
        } catch {
        }
        return;
      }
      if (runningStatus !== "stopped") return;
      this.releaseWorkerTask(ses, versionId);
      const scope = scopes.get(versionId);
      if (!scope) return;
      scopes.delete(versionId);
      console.log(`[mira-sw] stopped ${idFromScope(scope)} (v${versionId})`);
      this.restartWorker(ses, scope);
    });
  }
  /** Tail the console of every EXTENSION service worker in `ses` into a ring
   * buffer (read back by the extension-console command), mirrored to disk so it
   * survives a main reload. Website service workers are dropped — only messages
   * attributable to a chrome-extension are kept. Once per session. */
  hookServiceWorkerConsole(ses, scopes) {
    const buffer = this.loadSwConsole(ses);
    this.swConsole.set(ses, buffer);
    ses.serviceWorkers.on("console-message", (_event, details) => {
      const extensionId = this.resolveSwId(ses, details.versionId, details.sourceUrl, scopes);
      if (!extensionId) return;
      const entry = {
        extensionId,
        seq: ++this.swConsoleSeq,
        level: serviceWorkerLogLevel(details.level),
        message: details.message,
        sourceUrl: details.sourceUrl,
        lineNumber: details.lineNumber
      };
      buffer.push(entry);
      if (buffer.length > SW_CONSOLE_BUFFER_LIMIT) {
        buffer.splice(0, buffer.length - SW_CONSOLE_BUFFER_LIMIT);
      }
      this.appendSwConsole(ses, entry);
    });
  }
  /** Resolve a SW message to its extension id and cache the mapping. '' means
   * the message isn't from an extension we track (dropped by the caller). */
  resolveSwId(ses, versionId, sourceUrl, scopes) {
    const cached = this.swWorkerIds.get(ses)?.get(versionId);
    let scope = scopes.get(versionId);
    if (!scope && !cached && !sourceUrl) {
      try {
        scope = ses.serviceWorkers.getInfoFromVersionID(versionId).scope;
      } catch {
      }
    }
    const id = pickServiceWorkerExtensionId(sourceUrl, cached, scope);
    if (id) this.rememberSwId(ses, versionId, id);
    return id;
  }
  /** Cache versionId -> extension id for `ses` (no-op on empty id). */
  rememberSwId(ses, versionId, id) {
    if (!id) return;
    const ids = this.swWorkerIds.get(ses) ?? /* @__PURE__ */ new Map();
    this.swWorkerIds.set(ses, ids);
    ids.set(versionId, id);
  }
  /** Captured console output of `ses`'s extension service workers, filtered and
   * capped by `query`. Empty when nothing was captured — never throws. */
  serviceWorkerConsole(ses, query) {
    return selectServiceWorkerLogs(this.swConsole.get(ses) ?? [], query);
  }
  /** On-disk JSONL mirror path for `ses`'s SW console. Keyed by a hash of the
   * session's storage path so it is stable across reloads and unique per
   * profile (an in-memory session with no storage path shares one bucket). */
  swConsoleFilePath(ses) {
    const cached = this.swConsoleFile.get(ses);
    if (cached) return cached;
    const key = crypto.createHash("sha1").update(ses.getStoragePath() ?? "in-memory").digest("hex").slice(0, 16);
    const dir = path.join(electron.app.getPath("userData"), "sw-console");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const path$1 = path.join(dir, `${key}.jsonl`);
    this.swConsoleFile.set(ses, path$1);
    return path$1;
  }
  /** Load the disk mirror into a fresh ring buffer (last SW_CONSOLE_BUFFER_LIMIT
   * entries), rewrite the file to that tail so it stays bounded, seed the seq
   * counter, and rebuild the versionId->id cache from it. Best-effort. */
  loadSwConsole(ses) {
    const path2 = this.swConsoleFilePath(ses);
    let buffer = [];
    try {
      if (fs.existsSync(path2)) {
        buffer = fs.readFileSync(path2, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
      }
    } catch {
      buffer = [];
    }
    if (buffer.length > SW_CONSOLE_BUFFER_LIMIT) buffer = buffer.slice(-SW_CONSOLE_BUFFER_LIMIT);
    for (const entry of buffer) {
      this.swConsoleSeq = Math.max(this.swConsoleSeq, entry.seq);
    }
    try {
      fs.writeFileSync(path2, buffer.map((e) => JSON.stringify(e)).join("\n") + (buffer.length ? "\n" : ""));
    } catch {
    }
    return buffer;
  }
  /** Append one captured entry to `ses`'s disk mirror. Best-effort. */
  appendSwConsole(ses, entry) {
    try {
      fs.appendFileSync(this.swConsoleFilePath(ses), JSON.stringify(entry) + "\n");
    } catch {
    }
  }
  /** Hold a running extension worker alive with ServiceWorkerMain.startTask, so
   * Chromium never idle-terminates it and its in-memory state survives.
   * Idempotent per versionId; best-effort (the API is experimental). */
  holdWorkerAlive(ses, versionId, scope) {
    const tasks = this.workerTasks.get(ses) ?? /* @__PURE__ */ new Map();
    this.workerTasks.set(ses, tasks);
    if (tasks.has(versionId)) return;
    try {
      const worker = ses.serviceWorkers.getWorkerFromVersionID(versionId);
      if (!worker) return;
      tasks.set(versionId, worker.startTask());
      console.log(`[mira-sw] hold ${idFromScope(scope)} (v${versionId})`);
    } catch (error) {
      console.warn(`[mira] failed to hold extension SW ${scope} alive:`, error);
    }
  }
  /** Release the keepalive handle of a worker version (on stop/crash). */
  releaseWorkerTask(ses, versionId) {
    const tasks = this.workerTasks.get(ses);
    if (!tasks) return;
    const task = tasks.get(versionId);
    if (!task) return;
    tasks.delete(versionId);
    try {
      task.end();
    } catch {
    }
  }
  /** Restart one stopped extension worker, unless its extension was unloaded
   * meanwhile or it has been dying too fast (throttle). */
  restartWorker(ses, scope) {
    const stillLoaded = ses.extensions.getAllExtensions().some((ext) => ext.url === scope);
    if (!stillLoaded) return;
    const histories = this.workerRestarts.get(ses) ?? /* @__PURE__ */ new Map();
    this.workerRestarts.set(ses, histories);
    const { allowed, history } = recordWorkerRestart(histories.get(scope) ?? [], Date.now());
    histories.set(scope, history);
    if (!allowed) {
      console.warn(`[mira] extension SW ${scope} keeps dying — giving up on restarts for now`);
      return;
    }
    console.log(
      `[mira-sw] restart ${idFromScope(scope)} (${history.length} in ${WORKER_RESTART_WINDOW_MS / 1e3}s)`
    );
    ses.serviceWorkers.startWorkerForScope(scope).catch((error) => {
      console.warn(`[mira] failed to restart extension SW ${scope}:`, error);
    });
  }
  // --- Manifest sanitizing (fatal-permission strip) -------------------------
  /** Strip fatal permissions (declarativeNetRequest*) from an extension dir's
   * manifest.json, preserving the pristine manifest as a sibling
   * `manifest.mira-original.json` — readManifest prefers that file, so Tier B
   * still sees the DNR ruleset and Tier C still reports the gap. Idempotent
   * (an already-stripped manifest reports no change); returns whether the
   * on-disk manifest changed. Best-effort: an unreadable dir is left alone. */
  sanitizeExtensionDir(extPath) {
    try {
      const manifestPath = path.join(extPath, "manifest.json");
      const raw = fs.readFileSync(manifestPath, "utf8");
      const parsed = JSON.parse(raw);
      const { changed, manifest } = stripUnsupportedPermissions(parsed);
      if (!changed) return false;
      const backupPath = path.join(extPath, ORIGINAL_MANIFEST_FILE);
      if (!fs.existsSync(backupPath)) fs.writeFileSync(backupPath, raw, "utf8");
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
      console.log(`[mira] stripped unsupported permissions from ${extPath}`);
      return true;
    } catch {
      return false;
    }
  }
  /** Sanitize every extension directory under a profile's Web Store dir —
   * layout is storeDir/<id>/<version>_0/ for store installs, or a free-form
   * unpacked dir with a manifest.json at its root. Runs BEFORE
   * installChromeWebStore, whose loader loads them all. */
  sanitizeStoreDir(storeDir) {
    if (!fs.existsSync(storeDir)) return;
    for (const entry of fs.readdirSync(storeDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(storeDir, entry.name);
      if (fs.existsSync(path.join(dir, "manifest.json"))) {
        this.sanitizeExtensionDir(dir);
        continue;
      }
      for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
        if (sub.isDirectory() && fs.existsSync(path.join(dir, sub.name, "manifest.json"))) {
          this.sanitizeExtensionDir(path.join(dir, sub.name));
        }
      }
    }
  }
  // --- Tier B: declarativeNetRequest -> session.webRequest -----------------
  /** Rebuild `ses`'s DNR-derived webRequest mods from its currently loaded
   * extensions and (re)install the backing handlers. Called after any change to
   * the loaded set. Electron has no declarativeNetRequest; this enforces the
   * common rule actions (block/allow/redirect/modifyHeaders) via webRequest
   * (extensions-plan.md §8). Best-effort: a broken ruleset is skipped, not fatal.
   * NOTE (§3.1): installing a webRequest listener disables extensions' own
   * chrome.webRequest on this session — accepted (decision D3). */
  applyDnr(ses) {
    const rules = [];
    for (const ext of ses.extensions.getAllExtensions()) {
      rules.push(...this.readDnrRules(ext.path));
    }
    const mods = translateDnrRules(rules).filter((m) => m.action !== "unsupported");
    this.dnrBySession.set(ses, mods);
    if (mods.length === 0 && !this.dnrHooked.has(ses) && !this.hasExtensions(ses)) return;
    this.installWebRequest(ses);
  }
  /** Any extension currently loaded in `ses`? */
  hasExtensions(ses) {
    return ses.extensions.getAllExtensions().length > 0;
  }
  /** Install the three webRequest listeners that enforce this session's DNR mods
   * and the extension-frame Permissions-Policy relaxing. Once per session (only
   * one listener per event is allowed); they read the live state, so a later
   * applyDnr / extension load just updates it. */
  installWebRequest(ses) {
    if (this.dnrHooked.has(ses)) return;
    this.dnrHooked.add(ses);
    ses.webRequest.onBeforeRequest((details, cb) => {
      const mods = this.matchingDnr(ses, details);
      if (isDnrBlocked(mods)) return cb({ cancel: true });
      const redirectURL = pickDnrRedirect(mods);
      cb(redirectURL ? { redirectURL } : {});
    });
    ses.webRequest.onBeforeSendHeaders((details, cb) => {
      cb({
        requestHeaders: applyRequestHeaderMods(
          details.requestHeaders,
          this.matchingDnr(ses, details)
        )
      });
    });
    ses.webRequest.onHeadersReceived((details, cb) => {
      const headers = details.responseHeaders;
      if (!headers) return cb({});
      let out = applyResponseHeaderMods(headers, this.matchingDnr(ses, details));
      out = this.relaxDocumentPolicies(ses, details.resourceType, out);
      cb({ responseHeaders: out });
    });
  }
  /** Emulate Chrome's extension exemption from permissions policy: on document
   * responses, append the loaded extensions' origins to the media allowlists of
   * a Permissions-Policy header (relaxPermissionsPolicy). Responses without the
   * header — the common case — pass through untouched. */
  relaxDocumentPolicies(ses, resourceType, headers) {
    if (resourceType !== "mainFrame" && resourceType !== "subFrame") return headers;
    const policyKeys = Object.keys(headers).filter((k) => k.toLowerCase() === "permissions-policy");
    if (!policyKeys.length) return headers;
    const origins = ses.extensions.getAllExtensions().map((ext) => `chrome-extension://${ext.id}`);
    if (!origins.length) return headers;
    const out = { ...headers };
    for (const key of policyKeys) {
      out[key] = out[key].map((value) => relaxPermissionsPolicy(value, origins));
    }
    return out;
  }
  /** The DNR mods that apply to one request on `ses`. */
  matchingDnr(ses, details) {
    const list = this.dnrBySession.get(ses);
    if (!list || !list.length) return [];
    const req = {
      url: details.url,
      method: details.method ?? "GET",
      resourceType: details.resourceType ?? "other"
    };
    return list.filter((m) => dnrMatches(m, req));
  }
  /** Parse an extension's manifest, or null when unreadable. Prefers the
   * pristine `manifest.mira-original.json` kept by sanitizeExtensionDir, so DNR
   * rulesets (Tier B) and capability gaps (Tier C) reflect what the extension
   * really declares, not the stripped manifest Chromium loads. */
  readManifest(extPath) {
    for (const name of [ORIGINAL_MANIFEST_FILE, "manifest.json"]) {
      try {
        return JSON.parse(fs.readFileSync(path.join(extPath, name), "utf8"));
      } catch {
      }
    }
    return null;
  }
  /** The enabled DNR rules declared by an extension (across its rule_resources).
   * Best-effort: unreadable / disabled resources are skipped. */
  readDnrRules(extPath) {
    const manifest = this.readManifest(extPath);
    const dnr = manifest?.declarative_net_request;
    const resources = dnr && Array.isArray(dnr.rule_resources) ? dnr.rule_resources : [];
    const rules = [];
    for (const res of resources) {
      if (res?.enabled === false || typeof res?.path !== "string") continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(extPath, res.path), "utf8"));
        if (Array.isArray(parsed)) rules.push(...parsed);
      } catch (error) {
        console.warn(`[mira] failed to read DNR ruleset ${res.path}:`, error);
      }
    }
    return rules;
  }
  // --- Tier C: capability gaps --------------------------------------------
  /** The APIs an extension needs that Mira cannot fully provide (empty = none). */
  gapsFor(extPath) {
    const manifest = this.readManifest(extPath);
    return manifest ? detectCapabilityGaps(manifest) : [];
  }
  /** Attach capability gaps to an ExtensionInfo (omitted when there are none). */
  withGaps(info, extPath) {
    const gaps = this.gapsFor(extPath);
    return gaps.length ? { ...info, gaps } : info;
  }
  /** Enable Chrome Web Store support in `ses` (E5): navigating
   * chromewebstore.google.com in a tab of this profile turns "Add to Chrome"
   * into a real install (the paquet downloads/unpacks the .crx itself — no
   * dependence on Google's browser gate). Also loads, at this call, every
   * extension already installed under the profile's store directory, and keeps
   * them auto-updated. Once per session per run. */
  async installWebStore(ses, profileId) {
    if (this.webStoreSessions.has(ses)) return;
    this.webStoreSessions.add(ses);
    try {
      this.sanitizeStoreDir(this.deps.extensionsDirFor(profileId));
      this.hookPendingWebStoreInstalls(ses);
      await electronChromeWebStore.installChromeWebStore({
        session: ses,
        extensionsPath: this.deps.extensionsDirFor(profileId),
        // Also load unpacked dirs living in the store directory (e.g. Dark Reader
        // copied there by hand before E5 existed).
        allowUnpackedExtensions: true,
        autoUpdate: true,
        // Native confirm before an install, Chrome-style (extensions-plan.md §4.5).
        beforeInstall: async (details) => {
          const result = await electron.dialog.showMessageBox({
            type: "question",
            buttons: ["Install", "Cancel"],
            defaultId: 0,
            cancelId: 1,
            message: `Install "${details.localizedName || details.id}"?`,
            detail: "Extension from the Chrome Web Store"
          });
          const allowed = result.response === 0;
          if (allowed) {
            const pending = this.pendingWebStoreInstalls.get(ses) ?? /* @__PURE__ */ new Set();
            pending.add(details.id);
            this.pendingWebStoreInstalls.set(ses, pending);
          }
          return { action: allowed ? "allow" : "deny" };
        }
      });
      this.applyDnr(ses);
      this.launchWorkers(ses);
    } catch (error) {
      this.webStoreSessions.delete(ses);
      throw error;
    }
  }
  /** The Web Store package has no pre-load/after-download hook: after the user
   * accepts its in-page prompt it downloads and immediately calls
   * session.extensions.loadExtension on the pristine manifest. For extensions
   * such as Kondo that declare Electron's fatal DNR permission, observe that
   * one load, sanitize its newly known directory, then replace it with a clean
   * load. Programmatic installs are not marked pending and keep their explicit,
   * awaited sanitize/reload path in installFromStore. */
  hookPendingWebStoreInstalls(ses) {
    if (this.webStoreInstallHooked.has(ses)) return;
    this.webStoreInstallHooked.add(ses);
    ses.extensions.on("extension-loaded", (_event, extension) => {
      const pending = this.pendingWebStoreInstalls.get(ses);
      if (!pending?.delete(extension.id)) return;
      if (!this.sanitizeExtensionDir(extension.path)) return;
      setImmediate(() => {
        const current = ses.extensions.getExtension(extension.id);
        if (!current || current.path !== extension.path) return;
        ses.extensions.removeExtension(extension.id);
        void ses.extensions.loadExtension(extension.path).then(() => {
          this.applyDnr(ses);
          this.launchWorkers(ses);
        }).catch((error) => {
          console.error(`[mira] failed to reload Web Store extension ${extension.id}:`, error);
        });
      });
    });
  }
  /** Load every sideloaded extension recorded for `profileId` into its session.
   * Once per session per run. A missing / broken directory is skipped with a
   * warning — a deleted extension folder must not break boot. Paths inside the
   * profile's store directory are skipped: installWebStore's loader owns them
   * (loading twice would throw). */
  async loadInstalled(ses, profileId) {
    if (this.loadedSessions.has(ses)) return;
    this.loadedSessions.add(ses);
    const storeDir = this.deps.extensionsDirFor(profileId);
    for (const path2 of sideloadedFor(this.sideloaded, profileId)) {
      if (path2.startsWith(storeDir)) continue;
      try {
        this.sanitizeExtensionDir(path2);
        await ses.extensions.loadExtension(path2);
      } catch (error) {
        console.warn(`[mira] failed to load extension at ${path2}:`, error);
      }
    }
    this.applyDisabled(ses, profileId);
    this.applyDnr(ses);
    this.launchWorkers(ses);
  }
  /** Unload every extension the disabled registry lists for `profileId`. The
   * loaders (installWebStore's and the sideload loop above) don't know about
   * pauses, so they load everything and this strips the paused ones right
   * after — the pause is a session state, the files stay on disk. Entries are
   * refreshed from the live extension first (a store update while paused moves
   * the version directory), so resume always points at the current path. */
  applyDisabled(ses, profileId) {
    let changed = false;
    for (const entry of disabledFor(this.disabled, profileId)) {
      const ext = ses.extensions.getExtension(entry.id);
      if (!ext) continue;
      if (ext.path !== entry.path || ext.version !== entry.version) {
        this.disabled = addDisabled(this.disabled, profileId, {
          id: ext.id,
          name: ext.name,
          version: ext.version,
          path: ext.path
        });
        changed = true;
      }
      ses.extensions.removeExtension(entry.id);
    }
    if (changed) this.deps.persistDisabled(this.disabled);
  }
  /** One-click install from the Chrome Web Store by extension id (the same
   * pipeline the in-page "Add to Chrome" uses, minus the page). */
  async installFromStore(ses, profileId, id) {
    let ext = await electronChromeWebStore.installExtension(id, {
      session: ses,
      extensionsPath: this.deps.extensionsDirFor(profileId)
    });
    if (this.sanitizeExtensionDir(ext.path)) {
      ses.extensions.removeExtension(ext.id);
      ext = await ses.extensions.loadExtension(ext.path);
    }
    this.applyDnr(ses);
    this.launchWorkers(ses);
    return this.withGaps(toExtensionInfo(ext), ext.path);
  }
  /** Check every extension of `ses` for a Web Store update and install any.
   * An update reloads the extension, which would silently resume a paused one —
   * so the disabled registry is re-applied right after. */
  async update(ses, profileId) {
    await electronChromeWebStore.updateExtensions(ses);
    for (const ext of ses.extensions.getAllExtensions()) {
      if (this.sanitizeExtensionDir(ext.path)) {
        ses.extensions.removeExtension(ext.id);
        try {
          await ses.extensions.loadExtension(ext.path);
        } catch (error) {
          console.warn(`[mira] failed to reload ${ext.id} after manifest strip:`, error);
        }
      }
    }
    this.applyDisabled(ses, profileId);
    this.applyDnr(ses);
    this.launchWorkers(ses);
  }
  /** Pause an extension: unload it from `ses` (content scripts stop, its action
   * button disappears) but keep its files and registry records, and remember
   * the pause so boot re-applies it. Idempotent on an already-paused id. */
  disable(ses, profileId, id) {
    const paused = disabledFor(this.disabled, profileId).find((e) => e.id === id);
    if (paused) return toExtensionInfo(paused, false);
    const ext = ses.extensions.getExtension(id);
    if (!ext) throw new Error(`unknown extension: ${id}`);
    const entry = { id: ext.id, name: ext.name, version: ext.version, path: ext.path };
    ses.extensions.removeExtension(id);
    this.disabled = addDisabled(this.disabled, profileId, entry);
    this.deps.persistDisabled(this.disabled);
    this.applyDnr(ses);
    return toExtensionInfo(entry, false);
  }
  /** Resume a paused extension: load it back from its recorded directory and
   * forget the pause. Idempotent on an already-loaded id; throws on an id that
   * is neither loaded nor paused, or whose directory disappeared meanwhile. */
  async enable(ses, profileId, id) {
    const loaded = ses.extensions.getExtension(id);
    if (loaded) return toExtensionInfo(loaded);
    const paused = disabledFor(this.disabled, profileId).find((e) => e.id === id);
    if (!paused) throw new Error(`unknown extension: ${id}`);
    this.sanitizeExtensionDir(paused.path);
    const ext = await ses.extensions.loadExtension(paused.path);
    this.disabled = removeDisabled(this.disabled, profileId, id);
    this.deps.persistDisabled(this.disabled);
    this.applyDnr(ses);
    this.launchWorkers(ses);
    return this.withGaps(toExtensionInfo(ext), ext.path);
  }
  /** Load an unpacked extension directory into `ses` and record it for future
   * boots. Errors (bad path, invalid manifest) propagate to the command. */
  async load(ses, profileId, path2) {
    this.sanitizeExtensionDir(path2);
    const ext = await ses.extensions.loadExtension(path2);
    this.sideloaded = addSideloaded(this.sideloaded, profileId, path2);
    this.deps.persistSideloaded(this.sideloaded);
    this.applyDnr(ses);
    this.launchWorkers(ses);
    return this.withGaps(toExtensionInfo(ext), ext.path);
  }
  /** Extensions of the profile: the ones loaded in `ses` (enabled) plus the
   * paused ones from the disabled registry (enabled: false). */
  list(ses, profileId) {
    const loaded = ses.extensions.getAllExtensions().map((ext) => this.withGaps(toExtensionInfo(ext), ext.path));
    const loadedIds = new Set(loaded.map((e) => e.id));
    const paused = disabledFor(this.disabled, profileId).filter((e) => !loadedIds.has(e.id)).map((e) => this.withGaps(toExtensionInfo(e, false), e.path));
    return [...loaded, ...paused];
  }
  /** Remove an extension from `ses`: unload it, delete its Web-Store directory
   * if it was installed from the store (the paquet's uninstallExtension handles
   * both — its disk removal is a no-op for a sideload living elsewhere), and
   * forget any sideload record. Throws on an unknown id. Per profile by
   * construction: another profile's session — and its own copy of the
   * extension — is untouched. */
  async uninstall(ses, profileId, id) {
    const ext = ses.extensions.getExtension(id) ?? disabledFor(this.disabled, profileId).find((e) => e.id === id);
    if (!ext) throw new Error(`unknown extension: ${id}`);
    const storeDir = this.deps.extensionsDirFor(profileId);
    await electronChromeWebStore.uninstallExtension(id, { session: ses, extensionsPath: storeDir });
    if (ext.path.startsWith(storeDir + "/") && fs.existsSync(ext.path)) {
      fs.rmSync(ext.path, { recursive: true, force: true });
    }
    this.sideloaded = removeSideloaded(this.sideloaded, profileId, ext.path);
    this.deps.persistSideloaded(this.sideloaded);
    const nextDisabled = removeDisabled(this.disabled, profileId, id);
    if (nextDisabled !== this.disabled) {
      this.disabled = nextDisabled;
      this.deps.persistDisabled(this.disabled);
    }
    this.applyDnr(ses);
    return { removed: true };
  }
  /** Serve extension icons (crx://) in `ses`. Required by <browser-action-list>:
   * the chrome of EVERY profile window runs on the default session, so index.ts
   * calls this once for it — the handler then serves icons of extensions loaded
   * in any session (the lib resolves the target session from the crx url's
   * partition query). */
  serveCrxIcons(ses) {
    electronChromeExtensions.ElectronChromeExtensions.handleCRXProtocol(ses);
  }
  /** Track a freshly materialized tab so chrome.tabs sees it. No-op when the
   * session has no extension system (never happens in practice — ensureFor runs
   * at window create — but a guard beats a crash). */
  addTab(wc, window) {
    this.bySession.get(wc.session)?.addTab(wc, window);
  }
  /** Tell the extension system the active tab changed (chrome.tabs.onActivated). */
  selectTab(wc) {
    this.bySession.get(wc.session)?.selectTab(wc);
  }
  /** Untrack a tab about to be closed or discarded. */
  removeTab(wc) {
    this.bySession.get(wc.session)?.removeTab(wc);
  }
  /** The extensions' items for a right-click on `wc` (chrome.contextMenus):
   * ready-made native MenuItems, to append to Mira's own page menu. Empty when
   * no extension registered any (or the session has no extension system). */
  contextMenuItems(wc, params) {
    return this.bySession.get(wc.session)?.getContextMenuItems(wc, params) ?? [];
  }
  /** Deliver a named keyboard command to chrome.commands.onCommand listeners.
   * The lib overrides chrome.commands.onCommand with its own routed event (its
   * SW preload wins over ours), so the ONLY way to reach the listeners an
   * extension registered is the lib's internal router — reached through the
   * undocumented `ctx` of the instance, guarded so a lib upgrade that moves it
   * degrades to a warning, not a crash. Its sendEvent wakes a stopped service
   * worker before sending. */
  sendCommandEvent(ses, extensionId, command) {
    const instance = this.bySession.get(ses);
    const router = instance?.ctx?.router;
    if (!router || typeof router.sendEvent !== "function") {
      console.warn("[mira-commands] extensions lib router unavailable — command dropped:", command);
      return;
    }
    router.sendEvent(extensionId, "commands.onCommand", command);
  }
}
const SW_CONSOLE_BUFFER_LIMIT = 2e3;
function idFromScope(scope) {
  return scope.replace(/^chrome-extension:\/\//, "").replace(/\/$/, "");
}
function isDnrBlocked(mods) {
  const blocks = mods.filter((m) => m.action === "block");
  if (!blocks.length) return false;
  const maxBlock = Math.max(...blocks.map((m) => m.priority));
  return !mods.some((m) => m.action === "allow" && m.priority >= maxBlock);
}
function pickDnrRedirect(mods) {
  const redirects = mods.filter((m) => m.action === "redirect" && m.redirectUrl).sort((a, b) => b.priority - a.priority);
  return redirects.length ? redirects[0].redirectUrl ?? null : null;
}
function applyRequestHeaderMods(headers, mods) {
  const out = { ...headers };
  for (const m of mods) {
    if (m.action !== "modifyHeaders") continue;
    for (const name of m.removeRequestHeaders) deleteHeader(out, name);
    for (const { name, value } of m.setRequestHeaders) {
      deleteHeader(out, name);
      out[name] = value;
    }
  }
  return out;
}
function applyResponseHeaderMods(headers, mods) {
  const out = { ...headers };
  for (const m of mods) {
    if (m.action !== "modifyHeaders") continue;
    for (const name of m.removeResponseHeaders) deleteHeader(out, name);
    for (const { name, value } of m.setResponseHeaders) {
      deleteHeader(out, name);
      out[name] = [value];
    }
  }
  return out;
}
function deleteHeader(obj, name) {
  const lower2 = name.toLowerCase();
  for (const key of Object.keys(obj)) {
    if (key.toLowerCase() === lower2) delete obj[key];
  }
}
function bookmarkLabel(text) {
  const t = text.trim() || "Untitled";
  return t.length > 64 ? t.slice(0, 63) + "…" : t;
}
function bookmarkMenuItems(nodes, openBookmark) {
  return nodes.map(
    (node) => node.kind === "folder" ? {
      label: bookmarkLabel(node.title),
      submenu: node.children.length ? bookmarkMenuItems(node.children, openBookmark) : [{ label: "(empty)", enabled: false }]
    } : {
      label: bookmarkLabel(node.title || node.url),
      click: () => openBookmark(node.id)
    }
  );
}
function buildAppMenu(handlers) {
  const { profiles, focused } = handlers.listProfiles();
  const isMac = process.platform === "darwin";
  const profileItems = profiles.map((profile) => ({
    // Every known profile is listed (open or not). The radio marks the focused
    // one; clicking a closed profile opens it, an open one just focuses it.
    label: profile.label,
    type: "radio",
    checked: profile.id === focused,
    click: () => handlers.openProfile(profile.id)
  }));
  const settingsItem = {
    label: "Settings…",
    accelerator: "CmdOrCtrl+,",
    click: () => handlers.openSettings()
  };
  const macAppMenu = {
    role: "appMenu",
    submenu: [
      { role: "about" },
      { type: "separator" },
      settingsItem,
      { type: "separator" },
      { role: "services" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit" }
    ]
  };
  const fileMenu = {
    label: "File",
    submenu: [
      {
        label: "Command Palette…",
        accelerator: "CmdOrCtrl+K",
        click: () => handlers.togglePalette()
      },
      { type: "separator" },
      { label: "New Tab", accelerator: "CmdOrCtrl+T", click: () => handlers.newTab() },
      {
        label: "Duplicate Tab",
        accelerator: "CmdOrCtrl+Shift+D",
        click: () => handlers.duplicateTab()
      },
      { label: "Close Tab", accelerator: "CmdOrCtrl+W", click: () => handlers.closeTab() },
      {
        label: "Reopen Closed Tab",
        accelerator: "CmdOrCtrl+Shift+T",
        click: () => handlers.reopenTab()
      },
      // Cmd+S discards the active tab's page to reclaim RAM but keeps the tab
      // (asleep) and moves to the nearest already-loaded tab (never waking a
      // sleeping one) — not the browser's "Save Page As".
      { label: "Discard Tab", accelerator: "CmdOrCtrl+S", click: () => handlers.discardTab() },
      // Cmd+Shift+A: re-open every tab that was awake when Mira last quit (restore
      // only wakes the active one, the rest come back asleep). Was Cmd+Shift+R,
      // moved so that reflex maps to Hard Reload (History menu) like a browser.
      {
        label: "Wake All Tabs",
        accelerator: "CmdOrCtrl+Shift+A",
        click: () => handlers.wakeAllTabs()
      },
      { type: "separator" },
      // Move up / down the vertical tab strip; wraps around the ends. The
      // accelerator is shown for discoverability but NOT registered here
      // (registerAccelerator: false): the key is handled by a before-input-event
      // hook on every webContents (see wireTabShortcuts in profiles.ts) so it
      // beats a focused page that would otherwise swallow Cmd+Up/Down. The click
      // handler still fires when the item is chosen with the mouse.
      {
        label: "Previous Tab",
        accelerator: "CmdOrCtrl+Up",
        registerAccelerator: false,
        click: () => handlers.prevTab()
      },
      {
        label: "Next Tab",
        accelerator: "CmdOrCtrl+Down",
        registerAccelerator: false,
        click: () => handlers.nextTab()
      },
      // Back / forward through the tabs you've looked at (focus history), not the
      // strip order. Same display-only accelerator treatment as Previous/Next Tab:
      // the keys are handled by the before-input-event hook (wireTabShortcuts).
      {
        label: "Back to Recent Tab",
        accelerator: "CmdOrCtrl+Alt+Left",
        registerAccelerator: false,
        click: () => handlers.recentTabBack()
      },
      {
        label: "Forward to Recent Tab",
        accelerator: "CmdOrCtrl+Alt+Right",
        registerAccelerator: false,
        click: () => handlers.recentTabForward()
      },
      { type: "separator" },
      { role: "close", label: "Close Window", accelerator: "CmdOrCtrl+Shift+W" }
    ]
  };
  const template = [
    ...isMac ? [macAppMenu] : [],
    fileMenu,
    {
      // A hand-built Edit menu: the standard roles, plus Find. The default
      // role:'editMenu' has no Find section, and Cmd+F must go through the
      // registry (find-open) so the chrome's find bar opens whatever holds
      // focus — the page or the chrome.
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
        { type: "separator" },
        {
          label: "Find in Page…",
          accelerator: "CmdOrCtrl+F",
          click: () => handlers.openFind()
        },
        { label: "Find Next", accelerator: "CmdOrCtrl+G", click: () => handlers.findNext() },
        {
          label: "Find Previous",
          accelerator: "CmdOrCtrl+Shift+G",
          click: () => handlers.findPrevious()
        }
      ]
    },
    {
      // Back / forward. Cmd+Arrow accelerators work whatever holds focus (the
      // web content or the chrome), which a renderer keydown listener cannot do.
      label: "History",
      submenu: [
        { label: "Back", accelerator: "CmdOrCtrl+Left", click: () => handlers.goBack() },
        { label: "Forward", accelerator: "CmdOrCtrl+Right", click: () => handlers.goForward() },
        { type: "separator" },
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => handlers.reload() },
        {
          label: "Hard Reload",
          accelerator: "CmdOrCtrl+Shift+R",
          click: () => handlers.hardReload()
        }
      ]
    },
    {
      label: "Profiles",
      submenu: [
        ...profileItems.length ? profileItems : [{ label: "No profiles", enabled: false }],
        { type: "separator" },
        { label: "New Profile", click: () => handlers.newProfile() }
      ]
    },
    {
      // Favorites. Cmd+D bookmarks the active tab; the tree below (folders as
      // nested submenus, urls as items) is the favorites surface. The menu is
      // rebuilt on every bookmark change (see onBookmarksChange in index.ts).
      label: "Bookmarks",
      submenu: [
        {
          label: "Add to Favorites",
          accelerator: "CmdOrCtrl+D",
          click: () => handlers.addBookmark()
        },
        { type: "separator" },
        ...(() => {
          const tree = handlers.listBookmarks();
          return tree.length ? bookmarkMenuItems(tree, handlers.openBookmark) : [{ label: "No favorites", enabled: false }];
        })()
      ]
    },
    {
      // A hand-built View menu, deliberately WITHOUT the default role:'reload' /
      // role:'forceReload'. Those reload the *focused* webContents — which is
      // Mira's own chrome when the address bar / sidebar has focus — and their
      // Cmd+R accelerator would shadow our History → Reload (which reloads the
      // active TAB via the registry). Keep the rest of the standard View items.
      label: "View",
      submenu: [
        // Show/hide the two side panels. Menu accelerators (not renderer keydowns)
        // so they fire whatever holds focus — chrome or a focused page.
        {
          label: "Toggle Tab Sidebar",
          accelerator: "CmdOrCtrl+B",
          click: () => handlers.toggleTabsPanel()
        },
        {
          label: "Toggle AI Panel",
          accelerator: "CmdOrCtrl+J",
          click: () => handlers.toggleSkillPane()
        },
        {
          // Zen mode: hide toolbar + status bar + both panels in one shot; toggle
          // back to restore whatever was open. Character-mapped accelerator (not
          // globalShortcut), so H is fine on AZERTY (CLAUDE.md piège #4).
          label: "Toggle Zen Mode",
          accelerator: "CmdOrCtrl+Shift+H",
          click: () => handlers.toggleZen()
        },
        { type: "separator" },
        {
          label: "Toggle Developer Tools",
          accelerator: isMac ? "Alt+Cmd+I" : "Ctrl+Shift+I",
          click: () => handlers.toggleDevTools()
        },
        { type: "separator" },
        // Zoom the active TAB's page via the registry (like Reload above), NOT
        // the default zoom roles which target the focused webContents — Mira's
        // chrome when the address bar has focus. Cmd+= is the physical key for
        // "zoom in" (no Shift); a hidden twin binds Cmd+Plus so both fire it.
        { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: () => handlers.zoomReset() },
        { label: "Zoom In", accelerator: "CmdOrCtrl+=", click: () => handlers.zoomIn() },
        {
          label: "Zoom In",
          accelerator: "CmdOrCtrl+Plus",
          visible: false,
          click: () => handlers.zoomIn()
        },
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => handlers.zoomOut() },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    { role: "windowMenu" }
  ];
  electron.Menu.setApplicationMenu(electron.Menu.buildFromTemplate(template));
}
const SW_HEALTH_PROBE_SOURCE = String.raw`
(function () {
  try {
    if (!('serviceWorker' in navigator)) return JSON.stringify({ sw: 'no-api' })
    return navigator.serviceWorker.getRegistrations().then(
      function (regs) { return JSON.stringify({ sw: 'ok', count: regs.length }) },
      function (err) {
        return JSON.stringify({
          sw: 'error',
          name: (err && err.name) || '',
          message: String((err && err.message) || err)
        })
      }
    )
  } catch (e) {
    return JSON.stringify({ sw: 'throw', message: String((e && e.message) || e) })
  }
})();
`;
function interpretSwProbe(raw) {
  if (typeof raw !== "string") return { kind: "unparseable", detail: "non-string probe result" };
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { kind: "unparseable", detail: raw.slice(0, 200) };
  }
  const sw = obj?.sw;
  if (sw === "ok") return { kind: "ok", count: Number(obj.count) || 0 };
  if (sw === "no-api") return { kind: "no-api" };
  if (sw === "error" || sw === "throw") {
    const name = String(obj.name ?? "");
    const message = String(obj.message ?? "");
    const detail = [name, message].filter(Boolean).join(": ") || "unknown error";
    const invalidState = name === "InvalidStateError" || /invalid state/i.test(message);
    return invalidState ? { kind: "invalid-state", detail } : { kind: "other-error", detail };
  }
  return { kind: "unparseable", detail: raw.slice(0, 200) };
}
function swProbeLogLine(url2, verdict) {
  switch (verdict.kind) {
    case "invalid-state":
      return `[mira] stealth: service worker provider UNAVAILABLE on ${url2} — ${verdict.detail}. SW-dependent apps (e.g. WhatsApp Web) will hang on their splash; a reload usually recovers it.`;
    case "other-error":
      return `[mira] stealth: service worker check failed on ${url2} — ${verdict.detail}`;
    case "unparseable":
      return `[mira] stealth: service worker probe unreadable on ${url2} — ${verdict.detail}`;
    default:
      return null;
  }
}
const CHROME_SHIM_SOURCE = String.raw`
;(function () {
  try {
    var w = window
    if (typeof w.chrome === 'undefined' || w.chrome === null) {
      Object.defineProperty(w, 'chrome', { value: {}, configurable: true, enumerable: true, writable: true })
    }
    var c = w.chrome
    var now = function () { return Date.now() }
    if (!c.csi) {
      c.csi = function () {
        return { onloadT: now(), startE: now(), pageT: Math.random() * 1000, tran: 15 }
      }
    }
    if (!c.loadTimes) {
      c.loadTimes = function () {
        var t = now() / 1000
        return {
          requestTime: t, startLoadTime: t, commitLoadTime: t,
          finishDocumentLoadTime: t, finishLoadTime: t, firstPaintTime: t,
          firstPaintAfterLoadTime: 0, navigationType: 'Other',
          wasFetchedViaSpdy: true, wasNpnNegotiated: true,
          npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false,
          connectionInfo: 'h2'
        }
      }
    }
    if (!c.app) {
      c.app = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getDetails: function () { return null },
        getIsInstalled: function () { return false },
        runningState: function () { return 'cannot_run' }
      }
    }
    if (!c.runtime) {
      c.runtime = {
        OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
        OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
        PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
        RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
        connect: function () {
          return {
            onDisconnect: { addListener: function () {} },
            onMessage: { addListener: function () {} },
            postMessage: function () {},
            disconnect: function () {}
          }
        },
        sendMessage: function () {},
        id: undefined
      }
    }
  } catch (e) {
    /* never break a page over stealth */
  }
})();
`;
const wired = /* @__PURE__ */ new WeakSet();
function installStealthShim(wc) {
  if (wired.has(wc)) return;
  wired.add(wc);
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    wc.debugger.sendCommand("Page.enable").then(
      () => wc.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
        source: CHROME_SHIM_SOURCE
      })
    ).catch((error) => console.error("[mira] stealth: addScript failed", error));
  } catch (error) {
    console.error("[mira] stealth: debugger attach failed", error);
  }
  const reassert = () => {
    wc.executeJavaScript(CHROME_SHIM_SOURCE, true).catch(() => {
    });
  };
  wc.on("did-navigate", reassert);
  wc.on("dom-ready", reassert);
  wc.on("did-navigate", () => {
    const url2 = wc.getURL();
    if (!/^https?:/i.test(url2)) return;
    wc.executeJavaScript(SW_HEALTH_PROBE_SOURCE, true).then((raw) => {
      const line = swProbeLogLine(url2, interpretSwProbe(raw));
      if (line) console.warn(line);
    }).catch(() => {
    });
  });
}
function installStealth() {
  electron.app.on("web-contents-created", (_event, wc) => installStealthShim(wc));
}
function aboutPanelOptions({ version, year, chrome }) {
  return {
    applicationName: "Mira",
    applicationVersion: version,
    // The parenthesised "build" slot: surface the real Chromium version instead
    // of a copy of applicationVersion. Omitted when unknown so no empty "()".
    ...chrome ? { version: `Chromium ${chrome}` } : {},
    copyright: `© ${year} Mickael Faivre-Maçon`,
    // Shown under the version. "mira" = look (Latin mirari, to marvel) + a star:
    // a browser's job is to show the web.
    credits: "A personal web browser, built on Chromium.\nmira — “look”, from Latin mirari (to marvel), and a star."
  };
}
const SOCKET_PATH = process.env.MIRA_SOCKET ?? "/tmp/mira.sock";
let manager = null;
const pendingUrls = [];
electron.app.on("open-url", (event, url2) => {
  event.preventDefault();
  if (manager) manager.openUrl(url2);
  else pendingUrls.push(url2);
});
electron.app.on("open-file", (event, path2) => {
  event.preventDefault();
  const url$1 = url.pathToFileURL(path2).href;
  if (manager) manager.openUrl(url$1);
  else pendingUrls.push(url$1);
});
const TOOLBAR_HEIGHT = 48;
const STATUS_BAR_HEIGHT = 24;
function loadRenderer(window, profile, effectivePartition, theme) {
  const partition = effectivePartition ?? partitionForId(profile.id) ?? DEFAULT_SESSION_ALIAS;
  const search = `profile=${encodeURIComponent(profile.id)}&label=${encodeURIComponent(profile.label)}&partition=${encodeURIComponent(partition)}&theme=${encodeURIComponent(JSON.stringify(theme))}`;
  if (utils.is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    window.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}?${search}`);
  } else {
    window.loadFile(path.join(__dirname, "../renderer/index.html"), { search });
  }
}
electron.app.setName("Mira");
const logging = initLogging(electron.app.getPath("userData"));
console.log(`[mira] logging to ${logging.logsDir}`);
electron.app.setAboutPanelOptions(
  aboutPanelOptions({
    version: electron.app.getVersion(),
    year: (/* @__PURE__ */ new Date()).getFullYear(),
    chrome: process.versions.chrome
  })
);
electron.app.whenReady().then(async () => {
  if (pendingUrls.length > 0) {
    const forwarded = await forwardToRunningInstance(SOCKET_PATH, pendingUrls);
    if (forwarded) {
      pendingUrls.length = 0;
      electron.app.quit();
      return;
    }
  }
  utils.electronApp.setAppUserModelId("com.mira.app");
  electron.app.userAgentFallback = electron.app.userAgentFallback.replace(/ (?:Mira|Electron)\/\S+/g, "");
  installStealth();
  if (process.platform === "darwin" && electron.app.dock) {
    electron.app.dock.setIcon(icon);
  }
  electron.app.on("browser-window-created", (_, window) => {
    utils.optimizer.watchWindowShortcuts(window);
  });
  if (process.platform === "darwin" && !electron.app.isDefaultProtocolClient("http")) {
    electron.app.setAsDefaultProtocolClient("http");
    electron.app.setAsDefaultProtocolClient("https");
  }
  const profilesPath = path.join(electron.app.getPath("userData"), "profiles.json");
  const loadProfiles = () => {
    try {
      return normalizeProfiles(JSON.parse(fs.readFileSync(profilesPath, "utf8")));
    } catch {
      return defaultProfiles();
    }
  };
  const persistProfiles = (profiles2) => {
    try {
      fs.writeFileSync(profilesPath, JSON.stringify(profiles2, null, 2));
    } catch (error) {
      console.error("[mira] failed to persist profiles", error);
    }
  };
  const themesPath = path.join(electron.app.getPath("userData"), "themes.json");
  const loadThemes = () => {
    try {
      return normalizeThemes(JSON.parse(fs.readFileSync(themesPath, "utf8")));
    } catch {
      return normalizeThemes([]);
    }
  };
  const persistThemes = (themes) => {
    try {
      fs.writeFileSync(themesPath, JSON.stringify(themes, null, 2));
    } catch (error) {
      console.error("[mira] failed to persist themes", error);
    }
  };
  const sessionsPath = path.join(electron.app.getPath("userData"), "sessions.json");
  const loadSessions = () => {
    try {
      return normalizeSessions(JSON.parse(fs.readFileSync(sessionsPath, "utf8")));
    } catch {
      return {};
    }
  };
  const persistSessions = (sessions) => {
    try {
      fs.writeFileSync(sessionsPath, JSON.stringify(sessions, null, 2));
    } catch (error) {
      console.error("[mira] failed to persist sessions", error);
    }
  };
  const profileDir = (id) => path.join(electron.app.getPath("userData"), "profiles", id);
  const profileFile = (id, name) => path.join(profileDir(id), name);
  const loadProfileJson = (id, name, normalize) => {
    try {
      return normalize(JSON.parse(fs.readFileSync(profileFile(id, name), "utf8")));
    } catch {
      return normalize(void 0);
    }
  };
  const persistProfileJson = (id, name, value) => {
    try {
      fs.mkdirSync(profileDir(id), { recursive: true });
      fs.writeFileSync(profileFile(id, name), JSON.stringify(value, null, 2));
    } catch (error) {
      console.error(`[mira] failed to persist ${name} for profile ${id}`, error);
    }
  };
  const loadProfileHistory = (id) => loadProfileJson(id, "history.json", normalizeHistory);
  const persistProfileHistory = (id, history) => persistProfileJson(id, "history.json", history);
  const loadProfilePermissions = (id) => loadProfileJson(id, "permissions.json", normalizePermissions);
  const persistProfilePermissions = (id, permissions) => persistProfileJson(id, "permissions.json", permissions);
  const loadProfileBookmarks = (id) => loadProfileJson(id, "bookmarks.json", normalizeBookmarks);
  const persistProfileBookmarks = (id, bookmarks) => persistProfileJson(id, "bookmarks.json", bookmarks);
  const settingsPath = path.join(electron.app.getPath("userData"), "settings.json");
  const loadSettings = () => {
    try {
      return normalizeSettings(JSON.parse(fs.readFileSync(settingsPath, "utf8")));
    } catch {
      return normalizeSettings(void 0);
    }
  };
  const persistSettings = (settings) => {
    try {
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    } catch (error) {
      console.error("[mira] failed to persist settings", error);
    }
  };
  const initialSettings = loadSettings();
  const sideloadedPath = path.join(electron.app.getPath("userData"), "extensions.json");
  const loadSideloaded = () => {
    try {
      return normalizeSideloaded(JSON.parse(fs.readFileSync(sideloadedPath, "utf8")));
    } catch {
      return {};
    }
  };
  const persistSideloaded = (map) => {
    try {
      fs.writeFileSync(sideloadedPath, JSON.stringify(map, null, 2));
    } catch (error) {
      console.error("[mira] failed to persist extensions registry", error);
    }
  };
  const disabledPath = path.join(electron.app.getPath("userData"), "extensions-disabled.json");
  const loadDisabled = () => {
    try {
      return normalizeDisabled(JSON.parse(fs.readFileSync(disabledPath, "utf8")));
    } catch {
      return {};
    }
  };
  const persistDisabled = (map) => {
    try {
      fs.writeFileSync(disabledPath, JSON.stringify(map, null, 2));
    } catch (error) {
      console.error("[mira] failed to persist disabled-extensions registry", error);
    }
  };
  const extensionsService = new ExtensionsService({
    initialSideloaded: loadSideloaded(),
    persistSideloaded,
    initialDisabled: loadDisabled(),
    persistDisabled,
    // Web-Store installs land per profile (D2), Chrome-style layout on disk.
    extensionsDirFor: (profileId) => path.join(electron.app.getPath("userData"), "Extensions", profileId)
  });
  extensionsService.serveCrxIcons(electron.session.fromPartition(CHROME_PARTITION));
  const preloadPath = path.join(__dirname, "../preload/index.js");
  const profiles = new ProfileManager({
    toolbarHeight: TOOLBAR_HEIGHT,
    statusBarHeight: STATUS_BAR_HEIGHT,
    // Seed the panel widths from persisted settings (resizable at runtime); the
    // SIDEBAR_WIDTH / SKILL_PANE_WIDTH constants are only the CSS fallback default.
    sidebarWidth: initialSettings.sidebarWidth,
    skillPaneWidth: initialSettings.skillPaneWidth,
    homeUrl: initialSettings.homeUrl,
    initialLlm: initialSettings.llm,
    preloadPath,
    userDataDir: electron.app.getPath("userData"),
    ...process.platform === "linux" ? { icon } : {},
    initialProfiles: loadProfiles(),
    persist: persistProfiles,
    initialThemes: loadThemes(),
    persistThemes,
    initialSessions: loadSessions(),
    persistSessions,
    loadProfileBookmarks,
    persistProfileBookmarks,
    loadProfileHistory,
    persistProfileHistory,
    loadProfilePermissions,
    persistProfilePermissions,
    persistSettings,
    loadRenderer,
    // Mira is multi-process: sum the resident set of every Electron process
    // (main, GPU, each tab renderer) for the true footprint shown in the bar.
    getMemoryUsage: () => {
      const metrics = electron.app.getAppMetrics();
      const rss = metrics.reduce((sum, m) => sum + m.memory.workingSetSize * 1024, 0);
      return { rss, processes: metrics.length };
    },
    // Per-process working set keyed by pid, for the Settings tab-memory analysis.
    // workingSetSize is in KB (getAppMetrics), so scale to bytes like above.
    getProcessMemory: () => electron.app.getAppMetrics().map((m) => ({ pid: m.pid, bytes: m.memory.workingSetSize * 1024 })),
    extensions: extensionsService,
    onChange: () => {
      rebuildMenu();
      profiles.broadcastProfilesChanged();
    },
    // The favorites tree feeds the native Bookmarks menu — rebuild it on change.
    onBookmarksChange: () => rebuildMenu(),
    // The page right-click menu routes its Mira actions through the registry,
    // targeting the window that owns the right-clicked view (same bus as the
    // toolbar and the socket).
    runCommand: (wc, name, params) => runDetached(name, params, profiles.contextForChrome(wc))
  });
  function runDetached(name, params, ctx) {
    void Promise.resolve().then(() => registry.execute(name, params, ctx)).catch((error) => console.error(`[mira] command ${name} failed`, error));
  }
  function rebuildMenu() {
    buildAppMenu({
      listProfiles: () => profiles.listProfiles(),
      openProfile: (id) => {
        try {
          profiles.openProfile(id);
        } catch (error) {
          console.warn("[mira] menu open-profile:", error.message);
          runDetached("open-settings", { section: "profiles" }, profiles.contextForFocused());
        }
      },
      newProfile: () => profiles.createProfile(),
      // Route through the registry so it opens a Settings tab in the focused
      // window, like the toolbar / socket / Cmd+, path.
      openSettings: () => runDetached("open-settings", {}, profiles.contextForFocused()),
      // Cmd+K: toggle the command palette in the focused window, through the same
      // bus as everything else (no `open` arg → flip the current state).
      togglePalette: () => runDetached("toggle-palette", {}, profiles.contextForFocused()),
      // Cmd+B / Cmd+J: show/hide the left tab sidebar and the right AI panel, same
      // bus as their toolbar buttons (no arg → flip the current state).
      toggleTabsPanel: () => runDetached("toggle-tabs-panel", {}, profiles.contextForFocused()),
      toggleSkillPane: () => runDetached("toggle-skill-pane", {}, profiles.contextForFocused()),
      // Cmd+Shift+H: zen mode — hide/show the toolbar, status bar, and both panels
      // at once. Same bus as the socket / MCP (no arg → flip).
      toggleZen: () => runDetached("toggle-zen", {}, profiles.contextForFocused()),
      // Route the accelerators through the registry so they hit the same bus as
      // the toolbar buttons and the socket — the focused window is the target.
      goBack: () => runDetached("back", {}, profiles.contextForFocused()),
      goForward: () => runDetached("forward", {}, profiles.contextForFocused()),
      reload: () => runDetached("reload", {}, profiles.contextForFocused()),
      hardReload: () => runDetached("hard-reload", {}, profiles.contextForFocused()),
      newTab: () => runDetached("new-tab", {}, profiles.contextForFocused()),
      duplicateTab: () => runDetached("duplicate-active-tab", {}, profiles.contextForFocused()),
      closeTab: () => runDetached("close-active-tab", {}, profiles.contextForFocused()),
      reopenTab: () => runDetached("reopen-closed-tab", {}, profiles.contextForFocused()),
      discardTab: () => runDetached("discard-active-tab", {}, profiles.contextForFocused()),
      wakeAllTabs: () => runDetached("wake-all-tabs", {}, profiles.contextForFocused()),
      prevTab: () => runDetached("prev-tab", {}, profiles.contextForFocused()),
      nextTab: () => runDetached("next-tab", {}, profiles.contextForFocused()),
      recentTabBack: () => runDetached("recent-tab-back", {}, profiles.contextForFocused()),
      recentTabForward: () => runDetached("recent-tab-forward", {}, profiles.contextForFocused()),
      addBookmark: () => runDetached("add-bookmark", {}, profiles.contextForFocused()),
      // Zoom the focused window's active tab through the registry, same bus as
      // the socket/MCP — targets the page, not Mira's chrome.
      zoomIn: () => runDetached("zoom-in", {}, profiles.contextForFocused()),
      zoomOut: () => runDetached("zoom-out", {}, profiles.contextForFocused()),
      zoomReset: () => runDetached("zoom-reset", {}, profiles.contextForFocused()),
      // Cmd+F opens the find bar in the focused window; Cmd+G / Cmd+Shift+G step
      // the current search. Same bus as the chrome's find bar and the socket.
      openFind: () => runDetached("find-open", {}, profiles.contextForFocused()),
      findNext: () => runDetached("find-next", {}, profiles.contextForFocused()),
      findPrevious: () => runDetached("find-previous", {}, profiles.contextForFocused()),
      // Toggle the active tab's DevTools through the registry (same bus as the
      // socket/MCP) — targets the page's webContents, opened detached.
      toggleDevTools: () => runDetached("toggle-devtools", {}, profiles.contextForFocused()),
      // The Bookmarks submenu renders the favorites tree; clicking a url opens it.
      listBookmarks: () => profiles.listBookmarksTree(),
      openBookmark: (id) => runDetached("open-bookmark", { id }, profiles.contextForFocused())
    });
  }
  rebuildMenu();
  const registry = createCommandRegistry();
  electron.ipcMain.handle("command", (event, name, params) => {
    return registry.execute(name, params, profiles.contextForChrome(event.sender));
  });
  startCommandSocket(SOCKET_PATH, registry, () => profiles.contextForFocused());
  console.log(`[mira] control socket listening on ${SOCKET_PATH}`);
  const FOCUS_ACCELERATORS = ["CommandOrControl+Shift+M", "CommandOrControl+Shift+;"];
  for (const accelerator of FOCUS_ACCELERATORS) {
    const registered = electron.globalShortcut.register(
      accelerator,
      () => runDetached("focus-app", {}, profiles.contextForFocused())
    );
    if (!registered) {
      console.error(
        `[mira] failed to register global shortcut ${accelerator} (taken by another app?)`
      );
    }
  }
  const MEDIA_ACCELERATORS = ["CommandOrControl+Alt+Shift+M", "CommandOrControl+Alt+Shift+;"];
  for (const accelerator of MEDIA_ACCELERATORS) {
    const registered = electron.globalShortcut.register(
      accelerator,
      () => runDetached("toggle-media-gallery", {}, profiles.contextForFocused())
    );
    if (!registered) {
      console.error(
        `[mira] failed to register global shortcut ${accelerator} (taken by another app?)`
      );
    }
  }
  let quitVaultLockStarted = false;
  electron.app.on("before-quit", (event) => {
    profiles.beginQuit();
    if (quitVaultLockStarted || !profiles.hasUnlockedVaults()) return;
    quitVaultLockStarted = true;
    event.preventDefault();
    profiles.lockAllVaults().catch((error) => console.error("[mira] lock-on-quit failed", error)).finally(() => electron.app.quit());
  });
  electron.app.on("will-quit", () => profiles.flushPendingSaves());
  profiles.openSavedProfiles(parseProfileArg(process.argv, process.env));
  manager = profiles;
  for (const url2 of pendingUrls.splice(0)) profiles.openUrl(url2);
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) profiles.openProfile(DEFAULT_PROFILE_ID);
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    electron.app.quit();
  }
});
electron.app.on("will-quit", () => {
  electron.globalShortcut.unregisterAll();
  cleanupSocket(SOCKET_PATH);
});
const quitOnSignal = (signal) => {
  console.log(`[mira] received ${signal}, quitting`);
  electron.app.quit();
};
process.on("SIGINT", quitOnSignal);
process.on("SIGTERM", quitOnSignal);
