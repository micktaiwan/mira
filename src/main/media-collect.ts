// DOM media collection: the script injected into a page to harvest everything it
// is currently SHOWING, and the parser that normalizes its output into MediaItem
// records. This is the DOM half of the media gallery (media-capture.ts holds the
// network half and the merge).
//
// The script runs in the page's own world (via the tab's CDP debugger, like
// exec-js) and returns a JSON STRING — a plain, JSON-serializable payload that
// survives the socket/IPC hop without relying on deep structured-clone of live
// objects. It must never throw: a single bad element cannot abort the harvest.
//
// What it collects: <img> (incl. currentSrc from srcset), <picture>/<source>
// candidates, <video> (+ poster) and <audio> with their <source> children,
// inline <svg> (serialized to a data: URL), CSS background-image urls, and
// <canvas> exported to PNG (marked "tainted" when cross-origin taint blocks the
// export). Scanning is bounded so a huge page cannot hang the harvest.

import { classifyMedia, type MediaItem, type MediaKind } from './media-capture'

/** One raw record the in-page script emits (before normalization). */
export interface RawDomMedia {
  kind?: string
  url?: string
  width?: number
  height?: number
  alt?: string
  mime?: string
  tainted?: boolean
  poster?: string
  /** For a streamed video: the precise permalink URL to hand to yt-dlp (resolved
   * in-page from the DOM around the <video>). Absent for still media. */
  pageUrl?: string
}

/** In-page JS (a function DEFINITION injected as a string) that finds the best
 * "permalink" URL to hand to yt-dlp for the video at/above `el`: the closest
 * ancestor content permalink (X `/status/…`, YouTube watch, `/video/`, `/reel/`,
 * `/shorts/`), falling back to the page URL. A streamed (blob:/MSE) <video> has no
 * usable src, so this per-video URL is what makes a precise download possible on a
 * page holding many videos. Shared by the DOM harvest and the right-click resolver
 * so both pick URLs identically. Self-contained and defensive. */
export const PERMALINK_FN = String.raw`
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
`

/** Script evaluated in the page to harvest visible media. Returns a JSON string
 * of RawDomMedia[]. Self-contained and defensive: wrapped so any failure yields
 * "[]" rather than throwing into the caller. */
export const MEDIA_COLLECT_SOURCE = String.raw`
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
`

/** Page script that resolves the precise permalink for the video under a
 * right-click at viewport coordinates (x, y), for the context menu's "Download
 * Video" on a streamed video. Returns the URL string (or the page URL as a
 * fallback). Uses the same nearest-permalink logic as the DOM harvest. */
export function nearestVideoPermalinkSource(x: number, y: number): string {
  return `(function () {
    ${PERMALINK_FN}
    try {
      var el = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
      if (!el) return (typeof location !== 'undefined' && location.href) || '';
      return miraNearestPermalink(el) || location.href;
    } catch (e) { return (typeof location !== 'undefined' && location.href) || ''; }
  })();`
}

const KINDS: ReadonlySet<MediaKind> = new Set<MediaKind>([
  'image',
  'video',
  'audio',
  'svg',
  'canvas',
  'font',
  'other'
])

/** Normalize the in-page script's JSON output into MediaItem[] tagged with the
 * 'dom' source. Trusts the script's `kind` when valid, otherwise reclassifies
 * from mime/url. Never throws: bad JSON or a non-array yields []. Pure. */
export function parseDomMedia(raw: unknown): MediaItem[] {
  let arr: unknown
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw)
    } catch {
      return []
    }
  } else {
    arr = raw
  }
  if (!Array.isArray(arr)) return []
  const out: MediaItem[] = []
  for (const entry of arr as RawDomMedia[]) {
    if (!entry || typeof entry !== 'object') continue
    const url = typeof entry.url === 'string' ? entry.url : ''
    const pageUrl = typeof entry.pageUrl === 'string' ? entry.pageUrl : ''
    // Drop empty records — EXCEPT a tainted canvas, or a url-less video that still
    // carries a permalink (downloadable via yt-dlp even with no direct src).
    if (!url && !entry.tainted && !pageUrl) continue
    // When the record carries a MIME type it is authoritative — a <source
    // type="video/mp4"> is a video even if the script guessed "image". Fall back
    // to the script's kind only when there is no MIME to classify from (canvas,
    // inline SVG, CSS backgrounds carry none and set their own kind).
    const hasMime = typeof entry.mime === 'string' && entry.mime !== ''
    const kind: MediaKind = hasMime
      ? classifyMedia({ mime: entry.mime, url })
      : typeof entry.kind === 'string' && KINDS.has(entry.kind as MediaKind)
        ? (entry.kind as MediaKind)
        : classifyMedia({ url })
    const item: MediaItem = { url, kind, sources: ['dom'] }
    if (typeof entry.mime === 'string' && entry.mime) item.mime = entry.mime
    if (typeof entry.width === 'number' && entry.width > 0) item.width = entry.width
    if (typeof entry.height === 'number' && entry.height > 0) item.height = entry.height
    if (typeof entry.alt === 'string' && entry.alt) item.alt = entry.alt
    if (typeof entry.poster === 'string' && entry.poster) item.poster = entry.poster
    if (typeof entry.pageUrl === 'string' && entry.pageUrl) item.pageUrl = entry.pageUrl
    if (entry.tainted) item.tainted = true
    out.push(item)
  }
  return out
}
