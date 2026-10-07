import { VAMPIRE_BODY_Y, VAMPIRE_HAND_Y, VAMPIRE_SCALE } from './config'

/**
 * The solo run: five levels, each with one or more NPC bosses. Every NPC model has the same animation set
 * (idle, talk, blast_left, swing, hurt, kneel, kneel_idle, run) and is placed at the same scale as the lobby Vampire
 * (VAMPIRE_SCALE), so one fight engine drives them all. Edit this table to rebalance or reorder levels.
 */

export type NpcId = 'PumpkinLord' | 'Scarecrow' | 'Skelly' | 'Wizzir' | 'Witch' | 'Vampire'

export interface NpcDef {
  id: NpcId
  name: string
  model: string
  /** Standing height in model units (skeleton, from the .glb): sets where the raised hand and the chest are. */
  height: number
}

export const NPCS: Record<NpcId, NpcDef> = {
  PumpkinLord: { id: 'PumpkinLord', name: 'Pumpkin Lord', model: 'assets/models/npcs/PumpkinLord.glb', height: 2.44 },
  Scarecrow: { id: 'Scarecrow', name: 'Scarecrow', model: 'assets/models/npcs/ScareCrow.glb', height: 2.15 },
  Skelly: { id: 'Skelly', name: 'Skelly', model: 'assets/models/npcs/Skelly.glb', height: 2.14 },
  Wizzir: { id: 'Wizzir', name: 'Wizzir', model: 'assets/models/npcs/Wizzir.glb', height: 1.73 },
  Witch: { id: 'Witch', name: 'Witch', model: 'assets/models/npcs/Witch.glb', height: 1.8 },
  Vampire: { id: 'Vampire', name: 'Vampire', model: 'assets/models/npcs/Vampire.glb', height: 2.23 }
}

/** The VAMPIRE_* tuning numbers in config.ts were found on the Vampire (2.23 tall); other NPCs scale from that. */
const REFERENCE_HEIGHT = 2.23
export const handHeight = (npc: NpcDef, scale: number) => (VAMPIRE_HAND_Y / (REFERENCE_HEIGHT * VAMPIRE_SCALE)) * npc.height * scale
export const bodyHeight = (npc: NpcDef, scale: number) => (VAMPIRE_BODY_Y / (REFERENCE_HEIGHT * VAMPIRE_SCALE)) * npc.height * scale

/**
 * What a boss can do on his turn. His `attacks` list is played in order and repeats (his combo).
 *  - rally:  the base game. One homing pumpkin; swing it back, he bats it back a few times, then misses and is hurt.
 *  - volley: several homing pumpkins, one after another. Parry any of them to knock it away. The LAST one, if you parry it,
 *            flies back to him and starts a rally. Spaced so there is always time for a fresh swing between two arrivals.
 *  - orbs:   green orbs flying straight at where you stood. Do NOT swing at them: step out of the way.
 *  - tiles:  floor circles that fill up (telegraph) and then blast. Be off them when they pop.
 *  - meteor: explosive pumpkins thrown to land on the floor and blast. Be away from where they land.
 */
export type ShotKind = 'real' | 'decoy'
export type Attack =
  | { kind: 'rally' }
  | { kind: 'volley'; count: number; stagger: number; spread: number }
  | { kind: 'orbs'; count: number; stagger: number; spread: number }
  | { kind: 'tiles'; count: number; radius: number; telegraph: number; aimed: boolean }
  | { kind: 'meteor'; count: number; radius: number; telegraph: number }

export interface BossSpec {
  npc: NpcId
  hp: number
  /** Extra size on top of VAMPIRE_SCALE (the Vampire Master is bigger). */
  scaleMult?: number
  /** Name on the health bar, if not the NPC's own. */
  title?: string
  /** His combo: played in order, then again. */
  attacks: Attack[]
  /** Stands in front (closer to you) with the others behind him, in a level with several bosses. */
  front?: boolean
  /**
   * The final boss of a level with several. While any other boss is up he only uses floor and orb attacks (no pumpkins, so
   * he cannot be hurt). Once he is alone it is his last stand: he acts much faster, and keeps casting extra attacks while
   * his pumpkins are still in the air.
   */
  lastStand?: boolean
  /** From this share of his health he switches to a new combo (and tells you). */
  enraged?: { atHpFrac: number; attacks: Attack[] }
}

/**
 * Fire rings: walls of fire that start at the edge of the arena and close in. Touching one costs a heart, unless you cross
 * it through a gap. The gaps widen as the ring shrinks, and a new big ring is sent every `spawnEvery` seconds, so two or
 * three rings at once make corridors and mazes.
 */
export interface ZoneDef {
  startRadius: number
  endRadius: number
  seconds: number // how long a ring takes to close from start to end radius
  spawnEvery: number // seconds between new rings
  spawnEveryLastStand?: number // ...once a boss with `lastStand` is alone (rings come faster)
  gaps: number // openings per ring
  gapWidth: { start: number; end: number } // radians, widening as the ring shrinks
  thickness: number // metres
}

export interface LevelDef {
  name: string // banner text
  bosses: BossSpec[]
  /** Multiplies the pumpkin's speed. */
  speed: number
  /** Seconds between one attack ending and the next boss's turn starting. */
  pause: number
  /** A boss relocates between throws once he has taken this many hits... */
  moveAfter: number
  /** ...and from this many hits he keeps running around even while the pumpkin is in play (0 = always on the move). */
  roamAfter: number
  /** Extra times a boss bats the pumpkin back before he misses (on top of one more per hit he has taken). */
  extraReturns: number
  /** While a rally is going on, floor circles keep popping up around you, so it is never just standing and swinging. */
  rallyTiles?: { every: number; count: number; radius: number; telegraph: number }
  zone?: ZoneDef
}

const RALLY: Attack = { kind: 'rally' }
const volley = (count: number, stagger = 1.65, spread = 0.9): Attack => ({ kind: 'volley', count, stagger, spread })
const orbs = (count: number, stagger = 0.85, spread = 1.0): Attack => ({ kind: 'orbs', count, stagger, spread })
const tiles = (count: number, radius = 2.4, telegraph = 1.3, aimed = true): Attack => ({ kind: 'tiles', count, radius, telegraph, aimed })
const meteor = (count: number, radius = 2.8, telegraph = 1.4): Attack => ({ kind: 'meteor', count, radius, telegraph })

export const LEVELS: LevelDef[] = [
  // 1: the tutorial. One pumpkin, learn the swing.
  { name: 'Pumpkin Lord', bosses: [{ npc: 'PumpkinLord', hp: 3, attacks: [RALLY] }], speed: 1, pause: 1.4, moveAfter: 1, roamAfter: 2, extraReturns: 0 },

  // 2: volleys and the first floor tiles, and the floor keeps moving even during a rally
  {
    name: 'Scarecrow',
    bosses: [
      {
        npc: 'Scarecrow',
        hp: 4,
        attacks: [tiles(2, 2.4, 1.5), volley(3, 1.9), RALLY, tiles(3, 2.3, 1.3), volley(4, 1.73), RALLY]
      }
    ],
    speed: 1.12,
    pause: 1.1,
    moveAfter: 1,
    roamAfter: 0,
    extraReturns: 0,
    rallyTiles: { every: 8, count: 1, radius: 2.4, telegraph: 1.6 }
  },

  // 3: green orbs you must dodge, mixed with volleys and tiles
  {
    name: 'Skelly',
    bosses: [
      {
        npc: 'Skelly',
        hp: 4,
        attacks: [orbs(3, 0.9), RALLY, volley(3, 1.73), tiles(3, 2.2, 1.2), orbs(4, 0.8), volley(4, 1.65)]
      }
    ],
    speed: 1.2,
    pause: 1.0,
    moveAfter: 1,
    roamAfter: 0,
    extraReturns: 0,
    rallyTiles: { every: 7, count: 2, radius: 2.3, telegraph: 1.4 }
  },

  // 4: explosive pumpkins and fire rings, two bosses with their own combos
  {
    name: 'Wizzir & Witch',
    bosses: [
      {
        npc: 'Wizzir',
        hp: 3,
        attacks: [volley(4, 1.65), meteor(3), RALLY, orbs(3, 0.9)],
        enraged: { atHpFrac: 0.5, attacks: [volley(5, 1.57, 1.2), meteor(4, 2.8, 1.2), orbs(4, 0.8)] }
      },
      {
        npc: 'Witch',
        hp: 3,
        attacks: [tiles(4, 2.3, 1.2), orbs(4, 0.85), RALLY, volley(3, 1.65)],
        enraged: { atHpFrac: 0.5, attacks: [tiles(6, 2.3, 1.0), orbs(5, 0.8), volley(4, 1.57)] }
      }
    ],
    speed: 1.25,
    pause: 1.0,
    moveAfter: 1,
    roamAfter: 0,
    extraReturns: 0,
    rallyTiles: { every: 7, count: 2, radius: 2.3, telegraph: 1.3 },
    zone: { startRadius: 21, endRadius: 4, seconds: 42, spawnEvery: 27, gaps: 2, gapWidth: { start: 0.55, end: 1.5 }, thickness: 0.9 }
  },

  // 5: everyone, and the Vampire Master who combines it all and goes through a second phase
  {
    name: 'The Vampire Master',
    bosses: [
      { npc: 'PumpkinLord', hp: 2, attacks: [RALLY, meteor(2)] },
      { npc: 'Scarecrow', hp: 2, attacks: [volley(3, 1.73), RALLY] },
      { npc: 'Skelly', hp: 2, attacks: [orbs(4, 0.85), RALLY] },
      { npc: 'Wizzir', hp: 2, attacks: [meteor(3), volley(3, 1.65)] },
      { npc: 'Witch', hp: 2, attacks: [tiles(3, 2.3, 1.2), orbs(3, 0.9)] },
      {
        npc: 'Vampire',
        hp: 5,
        front: true,
        lastStand: true,
        scaleMult: 1.25,
        title: 'Vampire Master',
        attacks: [volley(5, 1.57, 1.2), tiles(4, 2.4, 1.2), meteor(3), orbs(4, 0.8), RALLY],
        enraged: {
          atHpFrac: 0.5,
          attacks: [volley(5, 1.48, 1.4), tiles(6, 2.4, 1.0), meteor(5, 2.8, 1.1), orbs(5, 0.75)]
        }
      }
    ],
    speed: 1.3,
    pause: 0.9,
    moveAfter: 1,
    roamAfter: 0,
    extraReturns: 0,
    rallyTiles: { every: 6, count: 2, radius: 2.3, telegraph: 1.3 },
    zone: { startRadius: 21, endRadius: 4, seconds: 46, spawnEvery: 30, spawnEveryLastStand: 20, gaps: 2, gapWidth: { start: 0.55, end: 1.5 }, thickness: 0.9 }
  }
]
