// Relative time for the audio history (Settings "Audio" and the toolbar audio
// menu): "just now", "5 min ago", "3 h ago", "2 d ago", then the calendar date
// past a week. Pure, so it is tested on its own. Lives in main and is shared with
// the renderer (tsconfig.web.json includes this one file).

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function timeAgo(at: number, now: number): string {
  const delta = Math.max(0, now - at)
  if (delta < MINUTE) return 'just now'
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)} min ago`
  if (delta < DAY) return `${Math.floor(delta / HOUR)} h ago`
  if (delta < 7 * DAY) return `${Math.floor(delta / DAY)} d ago`
  return new Date(at).toLocaleDateString()
}
