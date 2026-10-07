import { ARENA_FLOOR_Y, ARENA_RADIUS } from './config'

/**
 * The Vampire's hazards in a multiplayer round. The server decides everything (when, where, who is hit) and publishes a list of
 * entries (ArenaHazards component); every client, spectators included, draws the same list. An entry never streams per frame:
 * it carries its start time (server clock) and its parameters, and both sides compute where it is from the age. This file holds
 * those shared rules and every number you may want to tune.
 *
 *   tile:   a floor circle. It fills up for `b` seconds (telegraph), then blasts. x,z = centre, a = radius, b = telegraph.
 *   meteor: an explosive pumpkin that arcs in and blasts where it lands. Same fields as a tile.
 *   orb:    a green orb flying in a straight line. x,z = origin, a/b = direction (unit, flat), c = speed (m/s).
 *   ring:   a wall of fire closing in from the edge, with gaps. a = first gap's angle, b = how fast the gaps turn (rad/s),
 *           c = seconds it takes to close, d/e = gap width (rad) when it starts / when it ends.
 *
 * `t0` is when the entry starts (a cast: when the Vampire releases it, so the client charges until then).
 */
export type HazardKind = 'tile' | 'meteor' | 'orb' | 'ring'

export interface HazardEntry {
  id: number
  kind: string
  cast: number // entries of one Vampire cast share it (he plays the cast animation once per cast)
  t0: number // ms, server clock
  x: number
  z: number
  a: number
  b: number
  c: number
  d: number
  e: number
}

// ---- Pacing: everything about how the round heats up. Edit these and the preview reloads. ----
export const PACING = {
  vampireAtS: 20, // the Vampire rises in the middle
  firstCastDelayS: 5, // after he is up, before his first attack
  ringsFromS: 30, // the first fire ring
  castS: 1.5, // he charges this long before an attack is released (the clients show it)

  // The pressure clock. `p` (0..1) rises from 0 at rampFromS to 1 after rampSeconds on this clock, and everything below is
  // a gentle value at p = 0 and a hard one at p = 1. The clock runs a little faster when few players are left, so a duel does not drag.
  rampFromS: 40,
  rampSeconds: 420,
  crowdRate: [
    { aliveAtMost: 2, rate: 1.6 },
    { aliveAtMost: 3, rate: 1.3 },
    { aliveAtMost: 5, rate: 1.15 }
  ],
  overtimeStepS: 40, // once p has hit 1, every this many seconds each attack gets one more (so a round always ends)

  // Floor attacks (tiles, orbs, meteors): one cast every `castEvery` seconds
  castEvery: { easy: 12, hard: 5 },
  orbsFromP: 0.2, // orbs join the mix from this p, meteors from meteorsFromP
  meteorsFromP: 0.45,
  extraPerAlive: 12, // one more floor circle per this many players still alive (a big crowd needs more to be touched)
  tiles: { count: { easy: 1, hard: 4 }, radius: 2.4, telegraph: { easy: 2.2, hard: 1.4 }, stagger: 0.2, aimedMax: 2 },
  orbs: { count: { easy: 1, hard: 3 }, speed: { easy: 6, hard: 8.5 }, stagger: { easy: 1.2, hard: 0.9 }, aimedChance: 0.5 },
  meteors: { count: { easy: 1, hard: 2 }, radius: 2.8, telegraph: { easy: 2.4, hard: 1.7 }, stagger: 0.35 },

  // Fire rings: concentric, so they never overlap. The next one is sent once the last has moved `spacing` metres in.
  rings: {
    seconds: { easy: 90, hard: 60 }, // time to close (start radius to end radius). Easy is VERY slow: under 0.2 m/s
    spacing: { easy: 8, hard: 6.5 }, // metres between two rings: always room for a corridor
    gapWidth: { easy: 0.9, hard: 0.65 }, // radians when the ring starts; it widens to x2.2 by the time it is small
    gapSpin: { easy: 0.05, hard: 0.1 } // radians per second the gaps turn
  }
}

// ---- Geometry shared by the server (hits) and the clients (drawing) ----
export const RING_START_RADIUS = 21
export const RING_END_RADIUS = 4
export const RING_THICKNESS = 0.9
export const RING_HEIGHT = 0.85
export const RING_SEGMENTS = 40 // pieces of fire in one ring. Hits use the same pieces as the drawing, so what you see is what burns
export const RING_GAPS = 2
export const RING_ARM_S = 1.5 // a new ring fades in and only burns after this long
export const RING_BODY_RADIUS = 0.4
export const RING_HIT_COOLDOWN_S = 1.2 // after a ring burns you, rings leave you alone this long

export const ORB_Y = ARENA_FLOOR_Y + 1.2
export const ORB_HIT_RADIUS = 0.9
export const ORB_START_OFFSET = 0.6 // metres from the Vampire's centre
export const BLAST_FLASH_S = 0.35
export const BLAST_KEEP_S = 0.5 // an exploded circle stays in the list this long (the clients play the flash)
export const FLOOR_HIT_MAX_HEIGHT = 2.5 // someone in the air above this is clear of a blast

const TAU = Math.PI * 2

/** Smallest angle between two directions (radians, 0..PI). */
export function angleDiff(a: number, b: number): number {
  let d = (a - b) % TAU
  if (d > Math.PI) d -= TAU
  if (d < -Math.PI) d += TAU
  return Math.abs(d)
}

export const ringProgress = (e: HazardEntry, ageS: number) => Math.min(1, Math.max(0, ageS / e.c))
export const ringRadius = (u: number) => RING_START_RADIUS + (RING_END_RADIUS - RING_START_RADIUS) * u

/** Is piece `seg` of the ring inside one of its openings (no fire there)? */
export function ringSegmentOpen(e: HazardEntry, ageS: number, seg: number): boolean {
  const u = ringProgress(e, ageS)
  const width = e.d + (e.e - e.d) * u
  const angle = (seg / RING_SEGMENTS) * TAU
  for (let k = 0; k < RING_GAPS; k++) {
    if (angleDiff(angle, e.a + e.b * ageS + (k * TAU) / RING_GAPS) < width / 2) return true
  }
  return false
}

/** The piece of the ring that is nearest to a direction (radians). */
export function ringSegmentAt(angle: number): number {
  const i = Math.round((angle / TAU) * RING_SEGMENTS)
  return ((i % RING_SEGMENTS) + RING_SEGMENTS) % RING_SEGMENTS
}

/** Where an orb is `ageS` seconds after its release (flat heading, fixed height). */
export function orbPosition(e: HazardEntry, ageS: number): { x: number; y: number; z: number } {
  const d = e.c * Math.max(0, ageS)
  return { x: e.x + e.a * d, y: ORB_Y, z: e.z + e.b * d }
}

/** An orb that has not hit anyone fizzles out past the edge of the arena. */
export const orbLifeS = (e: HazardEntry) => (ARENA_RADIUS + 3) / e.c

/** How long a floor circle or meteor stays in the list: its telegraph, then the flash. */
export const floorLifeS = (e: HazardEntry) => e.b + BLAST_KEEP_S

export const lerp = (easy: number, hard: number, p: number) => easy + (hard - easy) * p

/** A tuning pair ({ easy, hard }) at pressure p (0..1). */
export const at = (pair: { easy: number; hard: number }, p: number) => lerp(pair.easy, pair.hard, p)
