/** How a pumpkin aimed at this player ended: a parry right on the perfect moment, a normal parry, or it hit you. */
export type ParryGrade = 'perfect' | 'good' | 'miss'

let eta: number | undefined
let etaAt = 0
const STALE_MS = 250 // nobody wrote it lately (a solo run paused for an intro, say): nothing is coming
let outcome: ParryGrade = 'good'
let outcomeAt = -Infinity

/**
 * The next pumpkin coming at this player, for the approach ring (targetMarker.ts) and the swing hints (parry.ts).
 * Whoever runs that pumpkin writes it every frame: the match pumpkin (setup.ts) or the solo run (solo.ts).
 */
export const incoming = {
  /**
   * Seconds until it reaches you (negative once it has, until it is resolved); undefined = nothing is coming at you.
   * Counted down from when it was written, so systems that read it before the writer runs in a frame see the same moment.
   */
  eta(): number | undefined {
    const age = Date.now() - etaAt
    return eta === undefined || age > STALE_MS ? undefined : eta - age / 1000
  },
  set(seconds: number | undefined) {
    eta = seconds
    etaAt = Date.now()
  },
  /** A pumpkin aimed at this player was just resolved. */
  resolve(grade: ParryGrade) {
    outcome = grade
    outcomeAt = Date.now()
  },
  outcome: () => outcome,
  /** ms since the last resolve. */
  sinceOutcome: () => Date.now() - outcomeAt
}
