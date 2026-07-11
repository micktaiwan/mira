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
}

/** Script evaluated in the page to harvest visible media. Returns a JSON string
 * of RawDomMedia[]. Self-contained and defensive: wrapped so any failure yields
 * "[]" rather than throwing into the caller. */
export const MEDIA_COLLECT_SOURCE = String.raw`
(function () {
  try {
    var out = []
    var seen = Object.create(null)
    var MAX_ELEMENTS = 6000
    function push(rec) {
      if (!rec) return
      // Dedup by url within the DOM pass; url-less records (tainted canvas) always pass.
      if (rec.url) { if (seen[rec.url]) return; seen[rec.url] = 1 }
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
      if (ssrc) push({ kind: srcKind, url: abs(ssrc), mime: so.getAttribute('type') || undefined })
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
      if (vsrc) push({ kind: 'video', url: abs(vsrc), width: vid.videoWidth || 0, height: vid.videoHeight || 0, poster: poster || undefined })
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

/** Page script that STARTS recording a playing <video> via captureStream +
 * MediaRecorder, stashing the growing state on `window.__miraRec`. Returns
 * quickly ('started' | 'no-video' | 'no-capture' | 'error') — the actual capture
 * runs asynchronously in the page for the clip's duration (main polls
 * MEDIA_RECORD_STATUS_SOURCE, then reads back `__miraRec.b64`). `url` selects the
 * matching video (by currentSrc/src); empty → the first playable one. Defensive:
 * any throw is recorded on `__miraRec` rather than propagated. */
export function mediaRecordStartSource(url: string): string {
  return `(function () {
    try {
      // One recording at a time per tab: the state lives on a single global, so a
      // second concurrent capture would corrupt the first. Refuse instead.
      if (window.__miraRec && window.__miraRec.status === 'recording') return 'busy';
      var want = ${JSON.stringify(url || '')};
      var vids = [].slice.call(document.querySelectorAll('video'));
      var v = want ? vids.filter(function (x) { return (x.currentSrc || x.src) === want; })[0] : null;
      if (!v) v = vids.filter(function (x) { return (x.readyState || 0) >= 2; })[0] || vids[0];
      if (!v) return 'no-video';
      var capture = v.captureStream || v.mozCaptureStream;
      if (!capture || !window.MediaRecorder) return 'no-capture';
      var elStream = capture.call(v);
      // Record a CANVAS we draw the video into, not the element's own video track.
      // When the gallery hides the web view the <video> stops PAINTING to screen,
      // which starves captureStream's video track (the "audio only, no frames"
      // bug) — but drawImage() still reads each decoded frame, so the canvas keeps
      // producing frames. Audio is taken straight from the element's stream.
      var canvas = document.createElement('canvas');
      canvas.width = v.videoWidth || 640;
      canvas.height = v.videoHeight || 360;
      var cctx = canvas.getContext('2d');
      var drawTimer = setInterval(function () {
        try {
          if (v.videoWidth && canvas.width !== v.videoWidth) { canvas.width = v.videoWidth; canvas.height = v.videoHeight; }
          cctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        } catch (e) {}
      }, 40);
      var out;
      if (canvas.captureStream) {
        out = new MediaStream();
        canvas.captureStream(25).getVideoTracks().forEach(function (t) { out.addTrack(t); });
        elStream.getAudioTracks().forEach(function (t) { out.addTrack(t); });
      } else {
        out = elStream; // no canvas capture support — fall back (may miss frames offscreen)
      }
      var types = ['video/mp4', 'video/webm;codecs=h264,opus', 'video/webm;codecs=vp9,opus', 'video/webm'];
      var mt = types.filter(function (t) { return MediaRecorder.isTypeSupported(t); })[0] || '';
      var rec = new MediaRecorder(out, mt ? { mimeType: mt } : undefined);
      var chunks = [];
      var dur = (isFinite(v.duration) && v.duration > 0) ? v.duration : 0;
      var R = { status: 'recording', error: '', size: 0, len: 0, mime: mt || 'video/webm', dur: dur, cur: 0, stalled: false };
      window.__miraRec = R;
      rec.ondataavailable = function (e) { if (e.data && e.data.size) { chunks.push(e.data); R.size += e.data.size; } };
      rec.onerror = function (e) { R.status = 'error'; R.error = String((e && e.error && e.error.message) || 'recorder error'); };
      rec.onstop = function () {
        // A stall stopped the recorder deliberately — keep the error verdict
        // instead of finalizing a truncated/empty file as success.
        if (R.stalled) { R.status = 'error'; if (!R.error) R.error = 'playback stalled'; return; }
        try {
          var blob = new Blob(chunks, { type: R.mime });
          var fr = new FileReader();
          fr.onload = function () { var s = String(fr.result || ''); var c = s.indexOf(','); R.b64 = c >= 0 ? s.slice(c + 1) : ''; R.len = R.b64.length; R.status = 'done'; };
          fr.onerror = function () { R.status = 'error'; R.error = 'read failed'; };
          fr.readAsDataURL(blob);
        } catch (e) { R.status = 'error'; R.error = String(e && e.message || e); }
      };
      var stop = function () { try { clearInterval(drawTimer); } catch (e) {} try { if (rec.state !== 'inactive') rec.stop(); } catch (e) {} };
      v.addEventListener('ended', stop, { once: true });
      // Hard ceiling on wall-clock in case 'ended' never fires.
      setTimeout(stop, ((dur > 0 ? dur : 60) + 3) * 1000);
      // Stall watchdog: if NEITHER playback time NOR the captured size advances for
      // a few seconds, the page is likely paused in the background (the gallery
      // hides the web view) — fail FAST with a clear reason instead of waiting the
      // whole duration for an empty file.
      // Gauge progress by PLAYBACK time, not captured size: the canvas emits
      // frames even when the video is paused (it re-draws the last frame), so
      // size alone can't reveal a stall. currentTime only advances while playing.
      var lastT = -1, stuck = 0;
      var wd = setInterval(function () {
        if (!window.__miraRec || R.status !== 'recording') { clearInterval(wd); return; }
        R.cur = v.currentTime || 0;
        var advanced = (v.currentTime !== lastT);
        lastT = v.currentTime;
        if (advanced) { stuck = 0; }
        else if (++stuck >= 4) {
          R.stalled = true;
          R.error = 'playback stalled (video paused in background?)';
          clearInterval(wd);
          stop();
        }
      }, 1000);
      v.muted = true;
      try { v.currentTime = 0; } catch (e) {}
      rec.start(1000);
      var p = v.play(); if (p && p.catch) p.catch(function () {});
      return 'started';
    } catch (e) {
      window.__miraRec = { status: 'error', error: String(e && e.message || e) };
      return 'error';
    }
  })();`
}

/** Page script that reads the current recording status as a JSON string (never
 * the payload itself — that is read separately in chunks). `cur`/`dur` drive a
 * progress display; `stalled` marks a background-pause failure. */
export const MEDIA_RECORD_STATUS_SOURCE = String.raw`(function () {
  var r = window.__miraRec;
  if (!r) return JSON.stringify({ status: 'missing' });
  return JSON.stringify({ status: r.status, error: r.error, size: r.size, len: r.len, mime: r.mime, dur: r.dur, cur: r.cur });
})();`

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
    // Drop empty records that are not the special tainted-canvas case.
    if (!url && !entry.tainted) continue
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
    if (entry.tainted) item.tainted = true
    out.push(item)
  }
  return out
}
