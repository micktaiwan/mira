// Relative time for the Settings "Audio" history: "just now", "5 min ago",
// "3 h ago", "2 d ago", then the calendar date past a week. Pure, so it is tested
// on its own and the row re-renders it against a ticking clock.

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
