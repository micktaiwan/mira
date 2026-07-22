/** Minimum time (ms) the reload spinner stays visible once shown. A page reload
 * can finish in a few dozen ms — without a floor the spinner would flash for a
 * single frame and stay imperceptible, which is the whole problem it solves. */
export const RELOAD_SPINNER_FLOOR_MS = 400

export interface SpinnerState {
  /** Whether the spinner should be shown right now. */
  visible: boolean
  /** Timestamp (ms) the spinner first became visible in the current load cycle,
   * or null while hidden. Kept across evaluations to measure the floor. */
  shownSince: number | null
  /** When > 0, the caller should re-evaluate after this many ms so the floor can
   * elapse and the spinner hide. 0 means no follow-up timer is needed. */
  holdMs: number
}

/** Decide the spinner's next state from the live `loading` flag, applying a
 * minimum-display floor so a near-instant reload is still perceptible.
 *
 * - `loading` true → visible now; opens the cycle (records `shownSince`) or keeps it.
 * - `loading` false, floor already elapsed → hide, close the cycle.
 * - `loading` false, still within the floor → stay visible and return the
 *   remaining time as `holdMs` so the caller schedules one re-check.
 *
 * Pure: the caller owns the clock (`now`) and the persisted `shownSince`. */
export function nextSpinnerState(
  loading: boolean,
  shownSince: number | null,
  now: number,
  floorMs: number = RELOAD_SPINNER_FLOOR_MS
): SpinnerState {
  if (loading) {
    return { visible: true, shownSince: shownSince ?? now, holdMs: 0 }
  }
  if (shownSince === null) {
    return { visible: false, shownSince: null, holdMs: 0 }
  }
  const remaining = floorMs - (now - shownSince)
  if (remaining <= 0) {
    return { visible: false, shownSince: null, holdMs: 0 }
  }
  return { visible: true, shownSince, holdMs: remaining }
}
