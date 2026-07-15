// The Mira home page: what a blank tab shows instead of about:blank's black void.
// A self-contained "session home" — profile name, open-tab count, memory footprint
// — loaded natively into the tab's WebContentsView as a data: URL (like the tooltip
// in tooltip-doc.ts). Colors mirror the renderer's base.css dark tokens (Mira is
// dark-only). The page carries a small inline <script> for the live clock/greeting
// only; the session stats are baked in at build time (a snapshot), so main rebuilds
// and reloads it whenever a blank tab is (re)selected — see profiles.ts.
//
// buildHomePage is pure and tested; profiles.ts gathers the stats and interpolates.

/** The session snapshot the home page renders. All primitives so this file stays
 * decoupled from Electron and the status-domain types — profiles.ts formats the
 * memory text (via formatMemory) and counts the tabs before calling in. */
export interface HomeStats {
  /** The active profile's display label (e.g. "Personal", "Work"). */
  profileLabel: string
  /** Total tabs in this window's strip (loaded + asleep). */
  tabCount: number
  /** Tabs with a live WebContentsView (materialized). */
  loadedCount: number
  /** Pre-formatted memory footprint, e.g. "142.5 MB" (see formatMemory). */
  memoryText: string
  /** How many Electron processes contributed to the memory figure. */
  processCount: number
}

/** A marker embedded in the page as an HTML comment. Its letters survive URL
 * encoding unchanged, so main can recognize "this navigation is our home page"
 * from the data: URL alone (isMiraHomeUrl) and keep the address bar / stored tab
 * url empty — the home is a blank tab, not a real destination. */
const HOME_MARKER = 'mira-home-page'

/** True when `url` is the Mira home page (or a plain blank). Used in profiles.ts's
 * did-navigate mirroring so loading the home never fills the address bar with the
 * data: URL nor persists it — a home tab's stored url stays ''. */
export function isMiraHomeUrl(url: string): boolean {
  return url === '' || url === 'about:blank' || url.includes(HOME_MARKER)
}

/** Escape a value for safe interpolation into HTML text/attributes. The profile
 * label is user-controlled (rename), so it must never break out into markup. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Build the full home-page HTML for a session snapshot. Self-contained: inline
 * CSS + one inline script (clock/greeting only). Safe to encode into a data: URL. */
export function buildHomePage(stats: HomeStats): string {
  const profile = escapeHtml(stats.profileLabel)
  const loadedNote =
    stats.loadedCount < stats.tabCount ? `${stats.loadedCount} loaded` : 'all loaded'
  const procNote = `${stats.processCount} process${stats.processCount === 1 ? '' : 'es'}`
  return `<!doctype html>
<html lang="en">
<!--${HOME_MARKER}-->
<head><meta charset="utf-8"><title>Mira</title><style>
  :root {
    --bg: #1b1b1f;
    --card: #222226;
    --line: #32363f;
    --t1: rgba(255, 255, 245, 0.86);
    --t2: rgba(235, 235, 245, 0.6);
    --t3: rgba(235, 235, 245, 0.38);
    --accent: #8aa0ff;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background:
      radial-gradient(1200px 600px at 50% -10%, rgba(138, 160, 255, 0.10), transparent 60%),
      radial-gradient(900px 500px at 90% 110%, rgba(138, 160, 255, 0.06), transparent 55%),
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
    filter: drop-shadow(0 0 14px rgba(138, 160, 255, 0.45));
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
    background: linear-gradient(180deg, #fff, #b9c2ff);
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
  .card:hover { border-color: #414853; transform: translateY(-2px); }
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
    background: #2b2b31;
    border: 1px solid var(--line);
    border-bottom-color: #23262d;
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
        <div class="sub">${escapeHtml(loadedNote)}</div>
      </div>
      <div class="card">
        <div class="label">Memory</div>
        <div class="value">${escapeHtml(stats.memoryText)}</div>
        <div class="sub">${escapeHtml(procNote)}</div>
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
  </script>
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
  </script>
</body>
</html>`
}

/** The home page as a data: URL, ready for view.webContents.loadURL. */
export function homePageUrl(stats: HomeStats): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(buildHomePage(stats))}`
}
