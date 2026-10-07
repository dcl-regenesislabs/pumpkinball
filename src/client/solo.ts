import {
  Animator,
  engine,
  Entity,
  GltfContainer,
  GltfNodeModifiers,
  InputModifier,
  MainCamera,
  Material,
  MaterialTransparencyMode,
  MeshRenderer,
  Transform,
  VirtualCamera
} from '@dcl/sdk/ecs'
import { Color4, Quaternion, Vector3 } from '@dcl/sdk/math'
import { getPlayer } from '@dcl/sdk/src/players'
import { movePlayerTo } from '~system/RestrictedActions'
import {
  ARENA_CENTER,
  ARENA_FLOOR_Y,
  ARENA_RADIUS,
  FALL_NET_DEPTH,
  FALL_NET_RANGE,
  INTRO_FIRST_SPAWN_S,
  INTRO_HOLD_S,
  INTRO_RISE_S,
  INTRO_STAGGER_S,
  MAX_HP,
  NPC_HURT_FLASH_S,
  NPC_RING_LIFT,
  NPC_RING_MODEL,
  NPC_RING_RADIUS,
  NPC_RING_SPIN_DEG_PER_S,
  PARRY_LATE_GRACE_S,
  PUMPKIN_AIM_HEIGHT,
  PUMPKIN_BOB_HEIGHT,
  PUMPKIN_CHARGE_START_SCALE,
  PUMPKIN_CONTACT_RADIUS,
  PUMPKIN_HIT_RADIUS,
  PUMPKIN_MODEL,
  PUMPKIN_MODEL_OFFSET_Y,
  PUMPKIN_MODEL_SCALE,
  PUMPKIN_TUMBLE_DEG_PER_S,
  SOLO_BOSS_POS,
  SOLO_SPAWN,
  VAMPIRE_BLAST_APPEAR_S,
  VAMPIRE_BLAST_LAUNCH_S,
  VAMPIRE_CLIPS,
  VAMPIRE_HAND_FORWARD,
  VAMPIRE_HAND_SIDE,
  VAMPIRE_MOVE_MIN_DISTANCE,
  VAMPIRE_MOVE_MIN_FROM_PLAYER,
  VAMPIRE_MOVE_RADIUS,
  VAMPIRE_RUN_ANIM_SPEED,
  VAMPIRE_RUN_SPEED,
  VAMPIRE_SCALE,
  VAMPIRE_STRIKE_Y,
  VAMPIRE_SWING_HIT_S,
  VAMPIRE_SWING_SPEED
} from '../shared/config'
import { room } from '../shared/messages'
import { PlayerState } from '../shared/schemas'
import { stepPumpkin } from '../shared/pumpkinSim'
import { Attack, bodyHeight, BossSpec, handHeight, LEVELS, NPCS, NpcDef, ShotKind, ZoneDef } from '../shared/soloLevels'
import { blastFx, chargeFx, decoyTrail, flightPuff, parryBurst, spawnFx, splash, trailBubble, trailReset } from './effects'
import { faceCameraAfter } from './cameraFace'
import { parryFeedback } from './feedback'
import { swing } from './parry'
import { BAT_HIT_SFX, EVIL_LAUGH_SFX, HURT_SFX, MAGIC_SPELL2_SFX, MAGIC_SPELL_SFX, playSfx, playSfxAt, PUMPKIN_CAST_SFX, SWING_SFX, WIN_SFX } from './sfx'
import { hooks, solo } from './soloState'

/**
 * Solo run: five levels (shared/soloLevels.ts). Each level has one or more NPC bosses, one taking a turn at a time.
 * On his turn a boss plays the next attack of his combo:
 *   rally   the basic game: a homing pumpkin you swing back; he bats it back a few times, then misses and is hurt
 *   volley  several homing pumpkins in a row: parry any to knock it away; parry the LAST one and it flies back to him and
 *           starts a rally
 *   orbs    green orbs flying straight at where you stood: step aside, never swing at them
 *   tiles   floor circles that fill up and then blast
 *   meteor  explosive pumpkins thrown to land on the floor and blast
 * Some levels also send fire rings closing in on you (cross them through the gaps). Each boss has his own health bar; a level is won when all are down.
 *
 * The whole fight runs on this client: bosses, pumpkins, hazards and score are local entities and are never synced, so
 * other players see none of it. The server only knows "this player is in a solo run" (status 'solo').
 */

const LOOPING = ['idle', 'kneel_idle', 'run']
const CLIPS = ['idle', 'talk', 'blast_left', 'swing', 'hurt', 'kneel', 'kneel_idle', 'run']
const PUMPKIN_HOVER_S = 0.2 // after the charge, before the first throw
const AFTER_INTRO_S = 0.8 // between the end of the level intro and the first attack
const FALL_COOLDOWN_S = 2
const ATTACK_TIMEOUT_S = 30 // safety: an attack that has not finished by now is cleared
const SPAWN_RADIUS = 11 // a lone boss, or a group, starts on an arc this far from the ring's centre, opposite the player
const SPAWN_ARC_STEP = (24 * Math.PI) / 180 // angle between neighbouring bosses
const BACK_RADIUS = 12 // with a front boss, the rest stand on a tighter arc behind him (so all of them fit the intro camera)
const BACK_ARC_STEP = (17 * Math.PI) / 180
const FRONT_RADIUS = 6.8 // and the front boss stands nearer the middle, toward the player

// ---- Special attack tuning ----
const DECOY_SPEED = 10 // m/s (times the level's speed)
const DECOY_HIT_RADIUS = 0.9 // a decoy that comes this close to you hits you
const DECOY_SWING_REACH = 1.9 // swing at a decoy this close and it blows up in your face
const HAZARD_Y = ARENA_FLOOR_Y + 0.06
const HAZARD_STAGGER_S = 0.14 // between floor circles of one attack
const METEOR_STAGGER_S = 0.25
const METEOR_ARC_HEIGHT = 3.2
const BLAST_FLASH_S = 0.35
const ZONE_SEGMENTS = 36 // pieces in one fire ring
const ZONE_HEIGHT = 0.85 // how tall the fire wall is
const ZONE_FIRST_RING_S = 6 // seconds into the fight before the first ring is sent
const ZONE_HIT_COOLDOWN_S = 1.2 // after a ring burns you, it cannot burn you again for this long
const PLAYER_BODY_RADIUS = 0.4

const SHOT_SFX_VOLUME = 0.62 // each pumpkin / orb leaving the boss (was 0.45 for orbs: raised about 38%)

// ---- Pacing ----
const PUMPKIN_EVERY_MIN = 3 // at least every 3-4 attacks, one is guaranteed to be a pumpkin (a rally or a volley)
const PUMPKIN_EVERY_MAX = 4
const LAST_STAND_PAUSE_MULT = 0.5 // a last-stand boss waits half as long between attacks
const OVERLAY_EVERY_S = 3.4 // in a last stand, an extra attack is cast this often while pumpkins are in the air
const OVERLAY_COMBO: Attack[] = [
  { kind: 'orbs', count: 3, stagger: 0.9, spread: 1.0 },
  { kind: 'tiles', count: 2, radius: 2.3, telegraph: 1.2, aimed: true },
  { kind: 'meteor', count: 2, radius: 2.8, telegraph: 1.3 },
  { kind: 'orbs', count: 4, stagger: 0.8, spread: 1.0 }
]

type Phase = 'wait' | 'attack' | 'over'

interface Boss {
  spec: BossSpec
  npc: NpcDef
  entity: Entity
  scale: number
  pos: Vector3
  moveTarget: Vector3
  hp: number
  maxHp: number
  hits: number // times he has been hit this level: decides how many returns he gets, and when he starts running
  act: 'free' | 'hurt' | 'kneel' | 'down'
  actT: number
  relocate: boolean // running to a new spot after being hit (before he roams for good)
  running: boolean // the run clip is playing
  puffClock: number
  idleIn: number // seconds until his throw / swing clip ends and he may idle or run again
  spawnAt: number // seconds into the level intro when he appears
  spawned: boolean
  depth: number // how far below the floor he waits before rising
  handY: number
  bodyY: number
  attackIdx: number
  enraged: boolean
  marker: Entity // the spinning ring on the floor under him
  flashT: number // seconds of red hurt flash left
}

/** A pooled pair of entities: a pumpkin (glb on a child) or a glowing orb (a sphere). */
interface Slot {
  body: Entity
  model: Entity
  kind: 'pumpkin' | 'orb'
  used: boolean
}

type ProjState = 'charge' | 'hover' | 'fly' | 'back' | 'swing' | 'meteor' | 'done'

interface Proj {
  kind: ShotKind
  owner: Boss
  slot: Slot
  state: ProjState
  pos: Vector3
  offset: Vector3 // while hovering: where it floats relative to the boss's hand
  rally: boolean // part of the rally: the boss bats it back instead of being hurt at once
  returns: number // times he has batted it back
  chain: number // parries so far: sets the speed
  flightT: number // seconds in the air (negative = still hovering)
  arrivedAt: number
  timer: number
  dir: Vector3 // decoys fly along this
  trailAt: Vector3 | undefined
  last: boolean // the last pumpkin of a volley: parried, it is the one that goes back to the boss
  size: number
  tumble: number
}

interface Ring {
  active: boolean
  age: number
  segs: Entity[]
  gapBase: number // angle of the first opening
  gapSpin: number // the openings slowly turn
  cd: number
}

interface Hazard {
  used: boolean
  fill: Entity
  edge: Entity
  center: Vector3
  radius: number
  t: number // negative = waiting its turn
  tele: number
  state: 'tele' | 'boom'
  boomT: number
  flyer?: Proj // a meteor's pumpkin, arcing in
  start?: Vector3
}

let bosses: Boss[] = []
let cur: Boss | undefined // the boss whose turn it is
let lastThrower: Boss | undefined
let slots: Slot[] = []
let projs: Proj[] = []
let hazards: Hazard[] = []
let rings: Ring[] = []
let introCam: Entity | undefined
let camCleanupT = 0 // seconds until the finished intro camera's component can go
let introT = 0
let victoryT = 0
let lastDefeated: Boss | undefined
let introFrozen = false
let nextRingAt = 0
let rallyTilesT = 0
let markerSpin = 0
let sinceThrow = 0 // attacks since the last pumpkin attack
let forceAt = PUMPKIN_EVERY_MIN
let overlayT = 0
let overlayIdx = 0
let lastStandAnnounced = false
let charging: { boss: Boss; atk: Attack; t: number; proj: Proj } | undefined

let phase: Phase = 'wait'
let timer = 0
let attackT = 0
let fallCooldown = 0
let startAskedAt = 0
let zoneT = 0
let lastAssertAt = 0
let outOfSyncSince = 0
const tipped = new Set<string>()

const level = () => LEVELS[Math.min(solo.level, LEVELS.length) - 1]

/** True while a pumpkin is on its way to this player (the ground ring shows then). */
export const soloPumpkinTargetsMe = () => solo.active && projs.some((p) => p.kind === 'real' && (p.state === 'hover' || p.state === 'fly'))

const playerPos = () => Transform.getOrNull(engine.PlayerEntity)?.position
const playerAim = (): Vector3 | undefined => {
  const p = playerPos()
  return p ? Vector3.create(p.x, p.y + PUMPKIN_AIM_HEIGHT, p.z) : undefined
}

function tip(key: string, text: string) {
  if (tipped.has(key)) return
  tipped.add(key)
  parryFeedback.notice(text)
}

// ---------------------------------------------------------------------------------------------------------------------
// Bosses
// ---------------------------------------------------------------------------------------------------------------------

/** Unit vector (flat) from a boss toward the player. */
function towardPlayer(b: Boss): { x: number; z: number } {
  const me = playerPos()
  if (!me) return { x: 0, z: 1 }
  const dx = me.x - b.pos.x
  const dz = me.z - b.pos.z
  const len = Math.hypot(dx, dz) || 1
  return { x: dx / len, z: dz / len }
}

/** Where a pumpkin forms while he charges it: up at his raised hand, a little toward the player. */
function hand(b: Boss): Vector3 {
  const f = towardPlayer(b)
  return Vector3.create(
    b.pos.x + f.x * VAMPIRE_HAND_FORWARD + f.z * VAMPIRE_HAND_SIDE,
    b.pos.y + b.handY,
    b.pos.z + f.z * VAMPIRE_HAND_FORWARD - f.x * VAMPIRE_HAND_SIDE
  )
}

/** Where a pumpkin comes back to and leaves from after the throw: about player height, in front of him. */
function strike(b: Boss): Vector3 {
  const f = towardPlayer(b)
  return Vector3.create(b.pos.x + f.x * VAMPIRE_HAND_FORWARD, b.pos.y + VAMPIRE_STRIKE_Y, b.pos.z + f.z * VAMPIRE_HAND_FORWARD)
}

const bodyPoint = (b: Boss) => Vector3.create(b.pos.x, b.pos.y + b.bodyY, b.pos.z)

function play(b: Boss, clip: string) {
  b.running = clip === 'run'
  Animator.playSingleAnimation(b.entity, clip, true)
}

function face(b: Boss) {
  const f = towardPlayer(b)
  Transform.getMutable(b.entity).rotation = Quaternion.lookRotation(Vector3.create(f.x, 0, f.z))
}

function publishBosses() {
  solo.bosses = bosses.map((b) => ({ name: b.spec.title ?? b.npc.name, hp: b.hp, maxHp: b.maxHp }))
}

/** True once a boss has been hit enough that he never stands still while pumpkins are in play. */
const roams = (b: Boss) => b.hits >= level().roamAfter

/** Busy with his own attack: charging, or about to swing a pumpkin back. Everything else he does is "ambient". */
const busyBoss = (b: Boss) => charging?.boss === b || projs.some((p) => p.owner === b && p.state === 'swing')

/** Picks where a boss runs to next: inside the ring, away from you, from where he stands and from the other bosses. */
function pickMoveTarget(b: Boss): Vector3 {
  const me = playerPos()
  let best = Vector3.clone(b.pos)
  for (let i = 0; i < 16; i++) {
    const a = Math.random() * Math.PI * 2
    const r = VAMPIRE_MOVE_RADIUS.min + Math.random() * (VAMPIRE_MOVE_RADIUS.max - VAMPIRE_MOVE_RADIUS.min)
    const c = Vector3.create(ARENA_CENTER.x + Math.cos(a) * r, ARENA_FLOOR_Y, ARENA_CENTER.z + Math.sin(a) * r)
    best = c
    const farFromMe = !me || Math.hypot(c.x - me.x, c.z - me.z) >= VAMPIRE_MOVE_MIN_FROM_PLAYER
    const movesEnough = Math.hypot(c.x - b.pos.x, c.z - b.pos.z) >= VAMPIRE_MOVE_MIN_DISTANCE
    const clear = bosses.every((o) => o === b || o.hp <= 0 || Math.hypot(c.x - o.moveTarget.x, c.z - o.moveTarget.z) >= 3)
    if (farFromMe && movesEnough && clear) break
  }
  return best
}

/** One step of a boss running toward his moveTarget, facing where he runs. Returns true when he gets there. */
function runStep(b: Boss, dt: number): boolean {
  const dx = b.moveTarget.x - b.pos.x
  const dz = b.moveTarget.z - b.pos.z
  const dist = Math.hypot(dx, dz)
  const step = VAMPIRE_RUN_SPEED * dt
  const t = Transform.getMutable(b.entity)
  if (dist <= step) {
    b.pos = Vector3.create(b.moveTarget.x, b.pos.y, b.moveTarget.z)
    t.position = b.pos
    return true
  }
  b.pos = Vector3.create(b.pos.x + (dx / dist) * step, b.pos.y, b.pos.z + (dz / dist) * step)
  t.position = b.pos
  t.rotation = Quaternion.lookRotation(Vector3.create(dx, 0, dz))
  b.puffClock -= dt
  if (b.puffClock <= 0) {
    b.puffClock = 0.14
    flightPuff(Vector3.create(b.pos.x, b.pos.y + 0.2, b.pos.z), 0.3)
  }
  return false
}

/** What a free boss does when he is not busy with an attack: watch you, relocate after a hit, or run around once hurt enough. */
function ambient(b: Boss, dt: number) {
  if (b.idleIn > 0) {
    b.idleIn -= dt // his throw / swing clip is still playing: let it finish
    if (b.idleIn > 0) return
    if (!roams(b) && !b.relocate) play(b, 'idle')
  }
  if (b.relocate) {
    if (!b.running) play(b, 'run')
    if (runStep(b, dt)) {
      b.relocate = false
      play(b, 'idle')
    }
    return
  }
  if (roams(b)) {
    if (!b.running) {
      play(b, 'run')
      b.moveTarget = pickMoveTarget(b)
    }
    if (runStep(b, dt)) b.moveTarget = pickMoveTarget(b)
  } else {
    if (b.running) play(b, 'idle')
    face(b)
  }
}

/** Hurt, kneel, down: each boss's own timeline after a hit, so a defeated boss goes straight from hurt into the kneel. */
function bossLife(b: Boss, dt: number) {
  if (b.act === 'hurt') {
    b.actT -= dt
    if (b.actT > 0) return
    if (b.hp <= 0) {
      play(b, 'kneel')
      b.act = 'kneel'
      b.actT = VAMPIRE_CLIPS.kneel
    } else {
      b.act = 'free'
      if (b.hits >= level().moveAfter && !roams(b)) {
        b.relocate = true
        b.moveTarget = pickMoveTarget(b)
        b.puffClock = 0
      }
    }
  } else if (b.act === 'kneel') {
    b.actT -= dt
    if (b.actT <= 0) {
      play(b, 'kneel_idle')
      b.act = 'down'
    }
  }
}

/** A pumpkin got through to a boss: red bubbles, the hurt clip, and when he is out of health, the kneel right after it. */
function hurtBoss(b: Boss) {
  b.hits++
  b.hp = Math.max(0, b.hp - 1)
  publishBosses()
  splash(bodyPoint(b)) // the red bubbles, like a hit player
  playSfxAt(HURT_SFX, bodyPoint(b), 1)
  const at = strike(b)
  parryBurst(at)
  playSfxAt(BAT_HIT_SFX, at, 1)
  play(b, 'hurt')
  startFlash(b)
  b.act = 'hurt'
  b.idleIn = 0
  b.relocate = false
  // A defeated boss goes straight from the hurt clip into the kneel (no idle pose in between)
  b.actT = b.hp <= 0 ? VAMPIRE_CLIPS.hurt : VAMPIRE_CLIPS.hurt + 0.15
  if (b.hp <= 0) {
    lastDefeated = b
    for (const p of projs) if (p.owner === b && p.state !== 'done') finishProj(p, true)
    const v = lastStandBoss()
    if (v && !lastStandAnnounced) {
      lastStandAnnounced = true
      spawnFx(v.pos, false)
      parryFeedback.notice(`${v.spec.title ?? v.npc.name}: LAST STAND!`)
    }
    return
  }
  const e = b.spec.enraged
  if (e && !b.enraged && b.hp / b.maxHp <= e.atHpFrac) {
    b.enraged = true
    b.attackIdx = 0
    spawnFx(b.pos, false)
    parryFeedback.notice(`${b.spec.title ?? b.npc.name} is enraged!`)
  }
}

/** A flat red look for an instant (the model's materials are overridden, then put back). */
function startFlash(b: Boss) {
  b.flashT = NPC_HURT_FLASH_S
  GltfNodeModifiers.createOrReplace(b.entity, {
    modifiers: [
      {
        path: '', // the whole model
        material: {
          material: {
            $case: 'pbr',
            pbr: {
              albedoColor: Color4.create(1, 0.08, 0.08, 1),
              emissiveColor: Color4.create(1, 0.05, 0.05, 1),
              emissiveIntensity: 2.5
            }
          }
        }
      }
    ]
  })
}

/** Every frame: the spinning ring under each living boss, and ending the red flash. */
function updateBossFx(dt: number) {
  markerSpin = (markerSpin + NPC_RING_SPIN_DEG_PER_S * dt) % 360
  const pulse = 1 + Math.sin(Date.now() / 1000 * 6) * 0.06
  for (const b of bosses) {
    const t = Transform.getMutable(b.marker)
    if (!b.spawned || b.hp <= 0) {
      t.scale = Vector3.Zero() // not up yet, or down for good
    } else {
      const r = NPC_RING_RADIUS * (b.scale / VAMPIRE_SCALE) * pulse
      t.position = Vector3.create(b.pos.x, ARENA_FLOOR_Y + NPC_RING_LIFT, b.pos.z)
      t.rotation = Quaternion.fromEulerDegrees(0, markerSpin, 0)
      t.scale = Vector3.create(r, 1, r)
    }
    if (b.flashT > 0) {
      b.flashT -= dt
      if (b.flashT <= 0) GltfNodeModifiers.deleteFrom(b.entity)
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Pooled entities: pumpkins, orbs, floor hazards, the closing circle
// ---------------------------------------------------------------------------------------------------------------------

export function glow(entity: Entity, color: Color4, intensity: number) {
  Material.setPbrMaterial(entity, {
    albedoColor: Color4.create(color.r * 0.3, color.g * 0.3, color.b * 0.3, 0),
    emissiveColor: color,
    emissiveIntensity: intensity,
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND
  })
}

export function setAlpha(entity: Entity, alpha: number) {
  const m = Material.getMutable(entity)
  if (m.material?.$case === 'pbr' && m.material.pbr.albedoColor) {
    const c = m.material.pbr.albedoColor
    m.material.pbr.albedoColor = Color4.create(c.r, c.g, c.b, alpha)
  }
}

const HAZARD_EDGE = Color4.create(1, 0.15, 0.05, 1)
const HAZARD_FILL = Color4.create(1, 0.55, 0.05, 1)
const ZONE_COLOR = Color4.create(1, 0.2, 0.1, 1)
const ORB_COLOR = Color4.create(0.2, 1, 0.1, 1)

function createPools() {
  for (let i = 0; i < 12; i++) {
    const body = engine.addEntity()
    Transform.create(body, { scale: Vector3.Zero() })
    const model = engine.addEntity()
    Transform.create(model, {
      parent: body,
      position: Vector3.create(0, PUMPKIN_MODEL_OFFSET_Y, 0),
      scale: Vector3.create(PUMPKIN_MODEL_SCALE, PUMPKIN_MODEL_SCALE, PUMPKIN_MODEL_SCALE)
    })
    GltfContainer.create(model, { src: PUMPKIN_MODEL })
    slots.push({ body, model, kind: 'pumpkin', used: false })
  }
  for (let i = 0; i < 6; i++) {
    const body = engine.addEntity()
    Transform.create(body, { scale: Vector3.Zero() })
    MeshRenderer.setSphere(body)
    Material.setPbrMaterial(body, {
      albedoColor: Color4.create(0.05, 0.3, 0.02, 1),
      emissiveColor: ORB_COLOR,
      emissiveIntensity: 1.2
    })
    slots.push({ body, model: body, kind: 'orb', used: false })
  }
  for (let i = 0; i < 14; i++) {
    const edge = engine.addEntity()
    Transform.create(edge, { scale: Vector3.Zero() })
    MeshRenderer.setCylinder(edge)
    glow(edge, HAZARD_EDGE, 0.9)
    const fill = engine.addEntity()
    Transform.create(fill, { scale: Vector3.Zero() })
    MeshRenderer.setCylinder(fill)
    glow(fill, HAZARD_FILL, 1.0)
    hazards.push({ used: false, fill, edge, center: Vector3.Zero(), radius: 1, t: 0, tele: 1, state: 'tele', boomT: 0 })
  }
}

function removePools() {
  for (const s of slots) {
    engine.removeEntity(s.model === s.body ? s.body : s.model)
    if (s.model !== s.body) engine.removeEntity(s.body)
  }
  for (const h of hazards) {
    engine.removeEntity(h.fill)
    engine.removeEntity(h.edge)
  }
  removeZone()
  slots = []
  hazards = []
  projs = []
  charging = undefined
}

/** Pools the fire rings of the current level (hidden until each is sent). */
function createZone(z: ZoneDef) {
  const count = Math.min(3, Math.ceil(z.seconds / Math.min(z.spawnEvery, z.spawnEveryLastStand ?? z.spawnEvery)) + 1)
  for (let r = 0; r < count; r++) {
    const segs: Entity[] = []
    for (let i = 0; i < ZONE_SEGMENTS; i++) {
      const e = engine.addEntity()
      Transform.create(e, { scale: Vector3.Zero() })
      MeshRenderer.setBox(e)
      glow(e, ZONE_COLOR, 1.5)
      segs.push(e)
    }
    rings.push({ active: false, age: 0, segs, gapBase: 0, gapSpin: 0, cd: 0 })
  }
}

function removeZone() {
  for (const r of rings) for (const e of r.segs) engine.removeEntity(e)
  rings = []
}

function acquire(kind: 'pumpkin' | 'orb'): Slot | undefined {
  const s = slots.find((x) => x.kind === kind && !x.used)
  if (s) s.used = true
  return s
}

function releaseSlot(s: Slot) {
  s.used = false
  Transform.getMutable(s.body).scale = Vector3.Zero()
}

function newProj(owner: Boss, kind: ShotKind, state: ProjState, pos: Vector3): Proj | undefined {
  const slot = acquire(kind === 'decoy' ? 'orb' : 'pumpkin')
  if (!slot) return undefined
  const p: Proj = {
    kind,
    owner,
    slot,
    state,
    pos: Vector3.clone(pos),
    offset: Vector3.Zero(),
    rally: false,
    returns: 0,
    chain: 0,
    flightT: 0,
    arrivedAt: 0,
    timer: 0,
    dir: Vector3.Forward(),
    trailAt: undefined,
    last: false,
    size: 0,
    tumble: Math.random() * 6
  }
  projs.push(p)
  return p
}

function finishProj(p: Proj, burst = false) {
  if (p.state === 'done') return
  if (burst) parryBurst(p.pos)
  p.state = 'done'
  releaseSlot(p.slot)
}

function clearAll() {
  for (const p of projs) finishProj(p)
  projs = []
  charging = undefined
  for (const h of hazards) releaseHazard(h)
  trailReset()
}

function releaseHazard(h: Hazard) {
  h.used = false
  if (h.flyer) finishProj(h.flyer)
  h.flyer = undefined
  Transform.getMutable(h.fill).scale = Vector3.Zero()
  Transform.getMutable(h.edge).scale = Vector3.Zero()
}

// ---------------------------------------------------------------------------------------------------------------------
// Level setup, entering and leaving
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Where each boss stands at the start. A group is spread along an arc on the far side of the ring from the player. If one of
 * them is the `front` boss, he takes the middle closest to the player and the others fan out on a wider arc behind him.
 */
function spawnPositions(specs: BossSpec[]): Vector3[] {
  const n = specs.length
  if (n === 1) return [Vector3.clone(SOLO_BOSS_POS)]
  const centerAngle = -Math.PI / 2 // toward -z, the side opposite the player's spawn
  const at = (angle: number, r: number) => Vector3.create(ARENA_CENTER.x + Math.cos(angle) * r, ARENA_FLOOR_Y, ARENA_CENTER.z + Math.sin(angle) * r)
  const hasFront = specs.some((sp) => sp.front)
  if (!hasFront) return specs.map((_, i) => at(centerAngle + (i - (n - 1) / 2) * SPAWN_ARC_STEP, SPAWN_RADIUS))
  const back = specs.filter((sp) => !sp.front).length
  let k = 0
  return specs.map((sp) => (sp.front ? at(centerAngle, FRONT_RADIUS) : at(centerAngle + (k++ - (back - 1) / 2) * BACK_ARC_STEP, BACK_RADIUS)))
}

function removeBosses() {
  for (const b of bosses) {
    engine.removeEntity(b.entity)
    engine.removeEntity(b.marker)
  }
  bosses = []
  cur = undefined
  lastThrower = undefined
  solo.bosses = []
}

/** (Re)builds the current level: fresh bosses at full health, the player's hearts back, spawn effects. */
function startLevel() {
  endVictory()
  clearAll()
  removeBosses()
  removeZone()
  const lvl = level()
  solo.phase = 'fight'
  solo.levelName = lvl.name
  solo.levelCount = LEVELS.length
  solo.hp = MAX_HP

  const starts = spawnPositions(lvl.bosses)
  lvl.bosses.forEach((spec, i) => {
    const npc = NPCS[spec.npc]
    const scale = VAMPIRE_SCALE * (spec.scaleMult ?? 1)
    const entity = engine.addEntity()
    const at = starts[i]
    const depth = npc.height * scale * 1.15
    // Waits under the floor (hidden by the ring) until the intro raises him out of it
    Transform.create(entity, { position: Vector3.create(at.x, at.y - depth, at.z), scale: Vector3.create(scale, scale, scale) })
    GltfContainer.create(entity, { src: npc.model, visibleMeshesCollisionMask: 0, invisibleMeshesCollisionMask: 0 })
    Animator.create(entity, {
      states: CLIPS.map((clip) => ({
        clip,
        playing: false,
        loop: LOOPING.includes(clip),
        speed: clip === 'swing' ? VAMPIRE_SWING_SPEED : clip === 'run' ? VAMPIRE_RUN_ANIM_SPEED : 1
      }))
    })
    const marker = engine.addEntity()
    Transform.create(marker, { position: Vector3.create(at.x, ARENA_FLOOR_Y + NPC_RING_LIFT, at.z), scale: Vector3.Zero() })
    GltfContainer.create(marker, { src: NPC_RING_MODEL, visibleMeshesCollisionMask: 0, invisibleMeshesCollisionMask: 0 })
    const b: Boss = {
      spec,
      npc,
      entity,
      scale,
      pos: at,
      moveTarget: Vector3.clone(at),
      hp: spec.hp,
      maxHp: spec.hp,
      hits: 0,
      act: 'free',
      actT: 0,
      relocate: false,
      running: false,
      puffClock: 0,
      idleIn: 0,
      spawnAt: INTRO_FIRST_SPAWN_S + i * INTRO_STAGGER_S,
      spawned: false,
      depth,
      handY: handHeight(npc, scale),
      bodyY: bodyHeight(npc, scale),
      attackIdx: 0,
      enraged: false,
      marker,
      flashT: 0
    }
    bosses.push(b)
    play(b, 'idle')
    face(b)
  })
  publishBosses()
  spawnFx(SOLO_SPAWN, false) // and a flash where the player lands
  if (lvl.zone) createZone(lvl.zone)

  phase = 'wait'
  timer = AFTER_INTRO_S
  attackT = 0
  zoneT = 0
  nextRingAt = ZONE_FIRST_RING_S
  rallyTilesT = 0
  sinceThrow = 0
  forceAt = PUMPKIN_EVERY_MIN
  overlayT = 0
  overlayIdx = 0
  lastStandAnnounced = false
  fallCooldown = FALL_COOLDOWN_S
  beginIntro()
}

/** Jump straight to a level (testing). */
export function jumpToLevel(n: number) {
  if (!solo.active) return
  solo.level = Math.max(1, Math.min(LEVELS.length, n))
  startLevel()
  toSpawn()
}

function toSpawn() {
  const look = bosses[0]?.pos ?? SOLO_BOSS_POS
  void movePlayerTo({
    newRelativePosition: SOLO_SPAWN,
    cameraTarget: Vector3.create(look.x, look.y + 1.5, look.z)
  }).catch(() => {})
}

/** The Vampire's offer was accepted: ask the server to move us onto the ring (it answers with soloAck). */
export function requestSoloStart(level = 1) {
  if (solo.active || solo.starting) return
  solo.startAt = level
  solo.starting = true
  startAskedAt = Date.now()
  console.log('[SOLO] asking the server to start a solo run')
  room.send('soloStart', { seq: 0 })
}

/** Leave the ring: the server brings us back to the lobby. */
export function leaveSolo() {
  if (!solo.active) return
  solo.active = false
  endIntro()
  endVictory()
  for (const b of bosses) spawnFx(b.pos, false)
  clearAll()
  removeBosses()
  removePools()
  // After beating the whole run, you come back standing by the Vampire, and he talks to you
  const talk = solo.epilogue
  solo.epilogue = false
  room.send('soloEnd', { seq: talk ? 1 : 0 })
  if (talk) hooks.epilogue()
}

/** After a defeat: the same level again from full health. */
export function retrySolo() {
  if (!solo.active || solo.phase !== 'lost') return
  startLevel()
  toSpawn()
}

/** After a win: the next level, or (after the last one) the whole run again from level 1. */
export function nextSoloLevel() {
  if (!solo.active || solo.phase !== 'won') return
  solo.level = solo.level < LEVELS.length ? solo.level + 1 : 1
  startLevel()
  toSpawn()
}

export function setupSolo() {
  room.onMessage('soloAck', (d) => {
    console.log('[SOLO] server answered, ok =', d.ok)
    solo.starting = false
    if (!d.ok) {
      parryFeedback.notice('Finish your match first')
      return
    }
    solo.active = true
    solo.level = Math.max(1, Math.min(LEVELS.length, solo.startAt))
    tipped.clear()
    createPools()
    startLevel()
  })

  room.onMessage('soloProgress', (d) => {
    solo.cleared = Math.max(solo.cleared, d.cleared)
  })

  engine.addSystem(fightSystem)
  engine.addSystem((dt: number) => {
    if (camCleanupT <= 0) return
    camCleanupT -= dt
    if (camCleanupT <= 0 && introCam && !solo.intro && !solo.victory) VirtualCamera.deleteFrom(introCam)
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// Damage and the end of a level
// ---------------------------------------------------------------------------------------------------------------------

function lose() {
  solo.phase = 'lost'
  phase = 'over'
  clearAll()
  playSfx(EVIL_LAUGH_SFX)
  const names = bosses.length > 1 ? 'They keep' : `${bosses[0]?.npc.name ?? 'He'} keeps`
  parryFeedback.eliminate(`${names} you`)
}

function win() {
  solo.phase = 'won'
  phase = 'over'
  clearAll()
  for (const r of rings) {
    r.active = false
    for (const e of r.segs) Transform.getMutable(e).scale = Vector3.Zero()
  }
  playSfx(WIN_SFX, 0.4)
  // Remember it (saved on the server, so the level selector is there next time)
  solo.cleared = Math.max(solo.cleared, solo.level)
  room.send('soloProgress', { cleared: solo.level })
  if (solo.level >= LEVELS.length) solo.epilogue = true
  beginVictory()
}

/** Testing: knocks one boss out per call (the others stay), so levels can be finished without playing them. */
export function killOneBoss() {
  if (!solo.active || solo.phase !== 'fight' || solo.intro || solo.victory) return
  const up = bosses.filter((b) => b.hp > 0)
  const target = up.find((b) => !b.spec.lastStand) ?? up[0]
  if (!target) return
  target.hp = 1
  hurtBoss(target)
}

/** The player loses a heart (a pumpkin, a blast, the closing circle). Returns true if that was the last one. */
function damagePlayer(at: Vector3, why: string): boolean {
  if (solo.phase !== 'fight') return false
  solo.hp = Math.max(0, solo.hp - 1)
  splash(at)
  playSfx(HURT_SFX)
  if (solo.hp <= 0) {
    lose()
    return true
  }
  parryFeedback.notice(`OUCH! ${why}${solo.hp} HP left`)
  return false
}

// ---------------------------------------------------------------------------------------------------------------------
// Attacks
// ---------------------------------------------------------------------------------------------------------------------

const isPumpkinAttack = (a: Attack) => a.kind === 'rally' || a.kind === 'volley'
const othersUp = (b: Boss) => bosses.some((o) => o !== b && o.hp > 0)

/** A last-stand boss cannot throw pumpkins (so cannot be hurt) while any other boss is still up. */
const canThrowPumpkins = (b: Boss) => !(b.spec.lastStand && othersUp(b))

/** The last-stand boss, once he is alone. */
function lastStandBoss(): Boss | undefined {
  return bosses.find((b) => b.spec.lastStand && b.hp > 0 && !othersUp(b))
}

const pause = () => level().pause * (lastStandBoss() ? LAST_STAND_PAUSE_MULT : 1)

/**
 * Next attack of a boss's combo (his enraged combo once he is hurt enough). Skips pumpkin attacks if he may not throw them,
 * and when `forcePumpkin` is set it is a rally or volley no matter what his combo says.
 */
function nextAttack(b: Boss, forcePumpkin: boolean): Attack {
  const e = b.spec.enraged
  const list = e && b.enraged ? e.attacks : b.spec.attacks
  const throws = canThrowPumpkins(b)
  if (forcePumpkin && throws) {
    // his own pumpkin attack if he has one, else a plain rally
    for (let i = 0; i < list.length; i++) {
      const cand = list[(b.attackIdx + i) % list.length]
      if (isPumpkinAttack(cand)) {
        b.attackIdx += i + 1
        return cand
      }
    }
    return { kind: 'rally' }
  }
  for (let i = 0; i < list.length; i++) {
    const cand = list[b.attackIdx++ % list.length]
    if (throws || !isPumpkinAttack(cand)) return cand
  }
  return { kind: 'tiles', count: 3, radius: 2.3, telegraph: 1.2, aimed: true }
}

/** Next boss to take a turn: a random one still standing and free, preferably not the one who just went. */
function pickThrower(forcePumpkin: boolean): Boss | undefined {
  const free = bosses.filter((b) => b.hp > 0 && b.act === 'free' && !b.relocate && (!forcePumpkin || canThrowPumpkins(b)))
  const others = free.filter((b) => b !== lastThrower)
  const pool = others.length > 0 ? others : free
  return pool[Math.floor(Math.random() * pool.length)]
}

function startAttack(b: Boss, atk: Attack) {
  const proj = newProj(b, 'real', 'charge', hand(b))
  if (!proj) {
    phase = 'wait'
    timer = pause()
    return
  }
  cur = b
  lastThrower = b
  b.idleIn = 0
  b.relocate = false
  play(b, 'blast_left')
  // A pumpkin attack (rally, volley, meteor) sounds the pumpkin cast; spells that are not pumpkins sound when the cast is over
  if (atk.kind === 'rally' || atk.kind === 'volley' || atk.kind === 'meteor') playSfx(PUMPKIN_CAST_SFX, 0.9)
  charging = { boss: b, atk, t: 0, proj }
  phase = 'attack'
  attackT = 0
}

/** The charge is over: the pumpkin is released as whatever the attack calls for. */
/**
 * Several shots hover around his hand, then go one after another. A volley is real pumpkins (parry any to knock it away; the
 * last one, parried, goes back and starts a rally); orbs are green and must be dodged. `first` is the pumpkin he was charging,
 * if any (an overlay cast has none).
 */
function spawnShots(b: Boss, kind: ShotKind, atk: { count: number; stagger: number; spread: number }, first?: Proj) {
  const f = towardPlayer(b)
  const n = atk.count
  const from = first ? first.pos : hand(b)
  for (let i = 0; i < n; i++) {
    let p: Proj | undefined
    if (i === 0 && first) {
      if (kind === 'decoy') {
        finishProj(first) // the charged pumpkin turns into an orb
        p = newProj(b, 'decoy', 'hover', from)
      } else p = first
    } else p = newProj(b, kind, 'hover', from)
    if (!p) continue
    p.state = 'hover'
    p.last = kind === 'real' && i === n - 1
    p.flightT = -(PUMPKIN_HOVER_S + i * atk.stagger)
    const side = (i - (n - 1) / 2) * atk.spread
    p.offset = Vector3.create(-f.z * side, (i % 2) * 0.4, f.x * side)
  }
  if (kind === 'decoy') tip('decoy', 'DODGE the green orbs!')
  else tip('volley', 'Parry the LAST one to hit back!')
}

/** An extra attack cast on top of the pumpkins already in the air (the Vampire's last stand). */
function castOverlay(b: Boss) {
  const atk = OVERLAY_COMBO[overlayIdx++ % OVERLAY_COMBO.length]
  b.idleIn = VAMPIRE_CLIPS.blast_left
  play(b, 'blast_left')
  parryBurst(hand(b))
  playSfxAt(SWING_SFX, hand(b), 1)
  switch (atk.kind) {
    case 'orbs':
      playSfx(MAGIC_SPELL_SFX, 0.85)
      spawnShots(b, 'decoy', atk)
      break
    case 'tiles':
      playSfx(MAGIC_SPELL2_SFX, 0.9)
      spawnTiles(b, atk)
      tip('tiles', 'Floor attack! MOVE!')
      break
    case 'meteor':
      playSfx(PUMPKIN_CAST_SFX, 0.9)
      spawnMeteors(b, atk)
      tip('meteor', 'Explosive pumpkins! MOVE!')
      break
    default:
      break
  }
}

function release(c: NonNullable<typeof charging>) {
  const { boss: b, atk, proj } = c
  charging = undefined
  parryBurst(proj.pos) // the release
  playSfxAt(SWING_SFX, proj.pos, 1)
  b.idleIn = VAMPIRE_CLIPS.blast_left - VAMPIRE_BLAST_LAUNCH_S

  switch (atk.kind) {
    case 'rally':
      proj.rally = true
      proj.state = 'hover'
      proj.flightT = -PUMPKIN_HOVER_S
      break

    case 'volley':
    case 'orbs':
      if (atk.kind === 'orbs') playSfx(MAGIC_SPELL_SFX, 0.85)
      spawnShots(b, atk.kind === 'orbs' ? 'decoy' : 'real', atk, proj)
      break

    case 'tiles':
      finishProj(proj, true)
      playSfx(MAGIC_SPELL2_SFX, 0.9)
      spawnTiles(b, atk)
      tip('tiles', 'Floor attack! MOVE!')
      break

    case 'meteor':
      finishProj(proj, true)
      spawnMeteors(b, atk)
      tip('meteor', 'Explosive pumpkins! MOVE!')
      break
  }
}

/** Where a floor circle goes: the first right where you stand, the rest spread around the ring and clear of each other. */
function pickTileCenters(count: number, radius: number, aimed: boolean): Vector3[] {
  const out: Vector3[] = []
  const me = playerPos()
  if (aimed && me) out.push(Vector3.create(me.x, HAZARD_Y, me.z))
  let guard = 0
  while (out.length < count && guard++ < 80) {
    const a = Math.random() * Math.PI * 2
    const r = Math.sqrt(Math.random()) * (ARENA_RADIUS - radius - 1)
    const c = Vector3.create(ARENA_CENTER.x + Math.cos(a) * r, HAZARD_Y, ARENA_CENTER.z + Math.sin(a) * r)
    if (out.every((o) => Math.hypot(o.x - c.x, o.z - c.z) >= radius * 1.7)) out.push(c)
  }
  return out
}

function acquireHazard(): Hazard | undefined {
  const h = hazards.find((x) => !x.used)
  if (h) h.used = true
  return h
}

function spawnTiles(b: Boss, atk: Extract<Attack, { kind: 'tiles' }>) {
  void b
  pickTileCenters(atk.count, atk.radius, atk.aimed).forEach((c, i) => {
    const h = acquireHazard()
    if (!h) return
    h.center = c
    h.radius = atk.radius
    h.tele = atk.telegraph
    h.t = -i * HAZARD_STAGGER_S
    h.state = 'tele'
    h.flyer = undefined
    h.start = undefined
  })
}

function spawnMeteors(b: Boss, atk: Extract<Attack, { kind: 'meteor' }>) {
  const me = playerPos()
  const start = hand(b)
  for (let i = 0; i < atk.count; i++) {
    let c: Vector3
    if (i === 0 && me) c = Vector3.create(me.x, HAZARD_Y, me.z)
    else {
      const a = Math.random() * Math.PI * 2
      const r = 2 + Math.random() * 6
      const base = me ?? ARENA_CENTER
      c = Vector3.create(base.x + Math.cos(a) * r, HAZARD_Y, base.z + Math.sin(a) * r)
    }
    // keep it on the ring
    const dx = c.x - ARENA_CENTER.x
    const dz = c.z - ARENA_CENTER.z
    const d = Math.hypot(dx, dz)
    const maxR = ARENA_RADIUS - atk.radius * 0.6
    if (d > maxR) c = Vector3.create(ARENA_CENTER.x + (dx / d) * maxR, HAZARD_Y, ARENA_CENTER.z + (dz / d) * maxR)
    const h = acquireHazard()
    if (!h) break
    const flyer = newProj(b, 'real', 'meteor', start)
    h.center = c
    h.radius = atk.radius
    h.tele = atk.telegraph
    h.t = -i * METEOR_STAGGER_S
    h.state = 'tele'
    h.flyer = flyer
    h.start = Vector3.clone(start)
  }
}

function explode(h: Hazard) {
  h.state = 'boom'
  h.boomT = BLAST_FLASH_S
  const c = Vector3.create(h.center.x, ARENA_FLOOR_Y, h.center.z)
  blastFx(c, h.radius)
  playSfxAt(BAT_HIT_SFX, c, 1)
  playSfxAt(HURT_SFX, c, 0.6)
  if (h.flyer) {
    finishProj(h.flyer)
    h.flyer = undefined
  }
  const me = playerPos()
  if (me && Math.hypot(me.x - h.center.x, me.z - h.center.z) <= h.radius && me.y <= ARENA_FLOOR_Y + 2.5) {
    damagePlayer(Vector3.create(me.x, me.y + 1, me.z), 'Blast! ')
  }
}

function updateHazards(dt: number) {
  for (const h of hazards) {
    if (!h.used) continue
    h.t += dt
    const edgeT = Transform.getMutable(h.edge)
    const fillT = Transform.getMutable(h.fill)
    if (h.state === 'tele') {
      if (h.t < 0) {
        // waiting its turn: a meteor's pumpkin hovers by the boss's hand meanwhile
        if (h.flyer) {
          h.flyer.pos = Vector3.clone(h.start ?? h.flyer.pos)
          h.flyer.size = 1
        }
        continue
      }
      const u = Math.min(1, h.t / h.tele)
      const d = h.radius * 2
      edgeT.position = Vector3.create(h.center.x, HAZARD_Y, h.center.z)
      edgeT.scale = Vector3.create(d, 0.03, d)
      fillT.position = Vector3.create(h.center.x, HAZARD_Y + 0.02, h.center.z)
      const fd = Math.max(0.05, d * u)
      fillT.scale = Vector3.create(fd, 0.03, fd)
      setAlpha(h.edge, 0.25 + 0.15 * Math.sin(h.t * (10 + 10 * u)))
      setAlpha(h.fill, 0.35 + 0.35 * u)
      if (h.flyer && h.start) {
        // the pumpkin arcs in and lands right as the circle is full
        const p = h.flyer
        p.pos = Vector3.create(
          h.start.x + (h.center.x - h.start.x) * u,
          h.start.y + (ARENA_FLOOR_Y + 0.5 - h.start.y) * u + Math.sin(Math.PI * u) * METEOR_ARC_HEIGHT,
          h.start.z + (h.center.z - h.start.z) * u
        )
        p.size = 1
        if (Math.floor(h.t * 20) !== Math.floor((h.t - dt) * 20)) trailBubble(p.pos)
      }
      if (u >= 1) explode(h)
    } else {
      h.boomT -= dt
      const k = Math.max(0, h.boomT / BLAST_FLASH_S)
      const d = h.radius * 2
      fillT.scale = Vector3.create(d, 0.03, d)
      setAlpha(h.fill, 0.9 * k)
      setAlpha(h.edge, 0.5 * k)
      if (h.boomT <= 0) releaseHazard(h)
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Projectiles
// ---------------------------------------------------------------------------------------------------------------------

/** Trail bubbles spaced by distance, per projectile (so several can fly at once). */
function trailStep(p: Proj) {
  if (!p.trailAt) {
    p.trailAt = Vector3.clone(p.pos)
    return
  }
  const dist = Vector3.distance(p.trailAt, p.pos)
  if (dist < 0.35) return
  const steps = Math.min(5, Math.floor(dist / 0.35))
  for (let i = 1; i <= steps; i++) {
    const at = Vector3.lerp(p.trailAt, p.pos, i / steps)
    if (p.kind === 'decoy') decoyTrail(at)
    else trailBubble(at)
  }
  p.trailAt = Vector3.clone(p.pos)
}

function parry(p: Proj) {
  swing.consume()
  parryFeedback.notice('PARRY!')
  parryFeedback.recordHit()
  parryBurst(p.pos)
  playSfx(BAT_HIT_SFX)
  if (!p.rally && !p.last) {
    // One of the first pumpkins of a volley: knocked away
    finishProj(p, true)
    return
  }
  // A rally pumpkin, or the last one of a volley: it flies back to the boss (and the last one starts a rally)
  if (p.last) p.rally = true
  p.state = 'back'
  p.chain++
  p.flightT = 0
  p.arrivedAt = 0
  p.trailAt = undefined
}

/** A parried pumpkin reached the boss who threw it: he bats it back a few times, then misses and is hurt. */
function arriveBack(p: Proj) {
  const b = p.owner
  if (p.returns < b.hits + 1 + level().extraReturns) {
    p.returns++
    p.state = 'swing'
    p.timer = 0
    b.idleIn = 0
    play(b, 'swing')
    playSfx(SWING_SFX)
    return
  }
  finishProj(p)
  hurtBoss(b)
}

function updateProj(p: Proj, dt: number) {
  p.tumble += dt
  const b = p.owner
  switch (p.state) {
    case 'charge':
    case 'meteor':
    case 'done':
      return

    case 'hover':
      p.flightT += dt
      p.pos = Vector3.add(hand(b), p.offset)
      p.size = 1
      if (p.flightT >= 0) {
        p.state = 'fly'
        p.arrivedAt = 0
        p.trailAt = undefined
        // The shot sound, for every pumpkin and orb as it leaves (a lone pumpkin or each one of a volley)
        playSfx(MAGIC_SPELL2_SFX, SHOT_SFX_VOLUME)
        if (p.kind === 'decoy') {
          const aim = playerAim()
          const d = aim ? Vector3.subtract(aim, p.pos) : Vector3.Forward()
          p.dir = Vector3.length(d) > 0.01 ? Vector3.normalize(d) : Vector3.Forward()
        }
      }
      return

    case 'swing':
      p.pos = strike(b)
      p.timer += dt
      if (p.timer >= VAMPIRE_SWING_HIT_S) {
        parryBurst(p.pos)
        playSfxAt(BAT_HIT_SFX, p.pos, 1)
        p.chain++
        p.state = 'fly'
        p.flightT = 0
        p.arrivedAt = 0
        p.trailAt = undefined
        b.idleIn = VAMPIRE_CLIPS.swing / VAMPIRE_SWING_SPEED - VAMPIRE_SWING_HIT_S
      }
      return

    case 'back': {
      p.flightT += dt
      const aim = strike(b)
      p.pos = stepPumpkin(p.pos, aim, p.chain, p.flightT, dt, level().speed)
      trailStep(p)
      if (Vector3.distance(p.pos, aim) <= PUMPKIN_HIT_RADIUS) arriveBack(p)
      return
    }

    case 'fly': {
      p.flightT += dt
      const aim = playerAim()
      if (!aim) return
      if (p.kind === 'decoy') {
        p.pos = Vector3.add(p.pos, Vector3.scale(p.dir, DECOY_SPEED * level().speed * dt))
        trailStep(p)
        const d = Vector3.distance(p.pos, aim)
        if (swing.live() && d <= DECOY_SWING_REACH) {
          // you swung at it: it blows up in your face
          swing.consume()
          const at = Vector3.clone(p.pos)
          finishProj(p, true)
          blastFx(Vector3.create(at.x, ARENA_FLOOR_Y, at.z), 1.4)
          damagePlayer(at, "Don't hit the green orb! ")
        } else if (d <= DECOY_HIT_RADIUS) {
          const at = Vector3.clone(p.pos)
          finishProj(p, true)
          damagePlayer(at, 'Dodge the green orbs! ')
        } else if (Math.hypot(p.pos.x - ARENA_CENTER.x, p.pos.z - ARENA_CENTER.z) > ARENA_RADIUS + 5 || p.flightT > 7) {
          finishProj(p, true) // it flew past you: it fizzles
        }
        return
      }
      p.pos = stepPumpkin(p.pos, aim, p.chain, p.flightT, dt, level().speed)
      trailStep(p)
      if (p.arrivedAt === 0 && Vector3.distance(p.pos, aim) <= PUMPKIN_CONTACT_RADIUS) p.arrivedAt = Date.now()
      if (p.arrivedAt > 0) {
        if (swing.live()) parry(p)
        else if (Date.now() - p.arrivedAt >= PARRY_LATE_GRACE_S * 1000) {
          const at = Vector3.clone(p.pos)
          finishProj(p)
          damagePlayer(at, '')
        }
      }
      return
    }
  }
}

function drawProj(p: Proj) {
  if (p.state === 'done') return
  const t = Transform.getMutable(p.slot.body)
  const bob = Math.sin(p.tumble * 7) * PUMPKIN_BOB_HEIGHT
  t.position = Vector3.create(p.pos.x, p.pos.y + bob, p.pos.z)
  if (p.slot.kind === 'orb') {
    const s = 0.8 * p.size * (1 + 0.1 * Math.sin(p.tumble * 14))
    t.scale = Vector3.create(s, s, s)
    return
  }
  t.rotation = Quaternion.fromEulerDegrees(
    (p.tumble * PUMPKIN_TUMBLE_DEG_PER_S.x) % 360,
    (p.tumble * PUMPKIN_TUMBLE_DEG_PER_S.y) % 360,
    (p.tumble * PUMPKIN_TUMBLE_DEG_PER_S.z) % 360
  )
  const pulse = p.state === 'back' && parryFeedback.sinceHit() < 200 ? 1.4 : 1
  const s = p.size * pulse
  t.scale = Vector3.create(s, s, s)
}

// ---------------------------------------------------------------------------------------------------------------------
// The closing circle
// ---------------------------------------------------------------------------------------------------------------------

const TAU = Math.PI * 2
/** Smallest angle between two directions (radians, 0..PI). */
function angleDiff(a: number, b: number): number {
  let d = (a - b) % TAU
  if (d > Math.PI) d -= TAU
  if (d < -Math.PI) d += TAU
  return Math.abs(d)
}

/** Is `angle` inside one of this ring's openings? */
function inGap(ring: Ring, z: ZoneDef, u: number, angle: number): boolean {
  const width = z.gapWidth.start + (z.gapWidth.end - z.gapWidth.start) * u
  for (let k = 0; k < z.gaps; k++) {
    const center = ring.gapBase + ring.gapSpin * ring.age + (k * TAU) / z.gaps
    if (angleDiff(angle, center) < width / 2) return true
  }
  return false
}

function updateZone(dt: number) {
  const z = level().zone
  if (!z || rings.length === 0) return
  zoneT += dt

  // Send a new big ring now and then
  if (solo.phase === 'fight' && zoneT >= nextRingAt) {
    nextRingAt = zoneT + (lastStandBoss() ? z.spawnEveryLastStand ?? z.spawnEvery : z.spawnEvery)
    const free = rings.find((r) => !r.active)
    if (free) {
      free.active = true
      free.age = 0
      free.cd = 0.5
      free.gapBase = Math.random() * TAU
      free.gapSpin = (Math.random() < 0.5 ? -1 : 1) * (0.1 + Math.random() * 0.12)
      tip('zone', 'Fire rings! Cross through the gaps!')
    }
  }

  const me = playerPos()
  for (const ring of rings) {
    if (!ring.active) continue
    ring.age += dt
    const u = Math.min(1, ring.age / z.seconds)
    if (u >= 1) {
      ring.active = false
      for (const e of ring.segs) Transform.getMutable(e).scale = Vector3.Zero()
      continue
    }
    const r = z.startRadius + (z.endRadius - z.startRadius) * u
    const arc = ((TAU * r) / ZONE_SEGMENTS) * 1.04
    ring.segs.forEach((e, i) => {
      const a = (i / ZONE_SEGMENTS) * TAU
      const t = Transform.getMutable(e)
      if (inGap(ring, z, u, a)) {
        t.scale = Vector3.Zero()
        return
      }
      t.position = Vector3.create(ARENA_CENTER.x + Math.cos(a) * r, ARENA_FLOOR_Y + ZONE_HEIGHT / 2, ARENA_CENTER.z + Math.sin(a) * r)
      t.rotation = Quaternion.lookRotation(Vector3.create(-Math.sin(a), 0, Math.cos(a)))
      t.scale = Vector3.create(z.thickness, ZONE_HEIGHT, arc)
      setAlpha(e, 0.5 + 0.2 * Math.sin(ring.age * 6 + i * 0.6))
    })

    // Touching the wall costs a heart (once in a while), unless you are crossing through a gap
    ring.cd -= dt
    if (solo.phase !== 'fight' || !me || ring.cd > 0 || me.y > ARENA_FLOOR_Y + 2.5) continue
    const dx = me.x - ARENA_CENTER.x
    const dz = me.z - ARENA_CENTER.z
    const d = Math.hypot(dx, dz)
    if (Math.abs(d - r) <= z.thickness / 2 + PLAYER_BODY_RADIUS && !inGap(ring, z, u, Math.atan2(dz, dx))) {
      ring.cd = ZONE_HIT_COOLDOWN_S
      damagePlayer(Vector3.create(me.x, me.y + 1, me.z), 'Fire ring! ')
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Level intro: a camera on the bosses as they rise out of the floor
// ---------------------------------------------------------------------------------------------------------------------

function introDuration(): number {
  const last = bosses.reduce((m, b) => Math.max(m, b.spawnAt), 0)
  return last + INTRO_RISE_S + INTRO_HOLD_S
}

/** Where the intro camera looks: the middle of the group, at chest height. */
function groupCenter(): Vector3 {
  let x = 0
  let z = 0
  for (const b of bosses) {
    x += b.pos.x
    z += b.pos.z
  }
  const n = Math.max(1, bosses.length)
  return Vector3.create(x / n, ARENA_FLOOR_Y + 1.6, z / n)
}

function aimIntroCamera(u: number) {
  if (!introCam) return
  const g = groupCenter()
  const e = u * u * (3 - 2 * u)
  const n = bosses.length
  const dist = Math.min(20, 9 + 1.7 * n) * (1 - 0.3 * e)
  const ang = ((-14 + 28 * e) * Math.PI) / 180 // a slow sweep across the group
  const eye = Vector3.create(g.x + Math.sin(ang) * dist, g.y - 0.4 + 1.6 * e, g.z + Math.cos(ang) * dist)
  const t = Transform.getMutable(introCam)
  t.position = eye
  t.rotation = Quaternion.lookRotation(Vector3.subtract(g, eye))
}

/** One camera entity for the whole session. It is never removed: the explorer blends back from it, and a camera that vanishes
 * during that blend sends the view to the world's origin for a moment. */
function ensureCam() {
  if (!introCam) {
    introCam = engine.addEntity()
    Transform.create(introCam, { position: Vector3.Zero() })
  }
  camCleanupT = 0
}

/** Look through the cinematic camera and hold the player still. */
function takeCamera() {
  if (!introCam) return
  VirtualCamera.createOrReplace(introCam, { defaultTransition: { transitionMode: VirtualCamera.Transition.Time(0.5) }, fov: 60 })
  MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: introCam })
  InputModifier.createOrReplace(engine.PlayerEntity, { mode: InputModifier.Mode.Standard({ disableAll: true }) })
  introFrozen = true
}

/** Hand the view and the controls back. The virtual camera (and where it stands) is left alone while the explorer blends out
 * of it; its component is removed a little later (see the system in setupSolo). */
function dropCamera() {
  if (introFrozen) {
    InputModifier.deleteFrom(engine.PlayerEntity) // the combat controls lock the jump again by themselves
    introFrozen = false
  }
  MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: undefined })
  camCleanupT = 2
  // Put the player's camera back behind the avatar, looking at the bosses (it can be left pitched straight down otherwise)
  faceCameraAfter(groupCenter())
}

function beginIntro() {
  ensureCam()
  introT = 0
  solo.intro = true
  solo.introAge = 0
  solo.introDur = introDuration()
  aimIntroCamera(0)
  takeCamera() // the player stands still and watches
}

function endIntro() {
  if (solo.intro) {
    solo.intro = false
    dropCamera()
  }
  // everyone standing exactly on the floor
  for (const b of bosses) {
    if (b.spawned) Transform.getMutable(b.entity).position = b.pos
  }
}

function updateIntro(dt: number) {
  introT += dt
  solo.introAge = introT
  for (const b of bosses) {
    if (introT < b.spawnAt) continue
    if (!b.spawned) {
      b.spawned = true
      spawnFx(b.pos) // the teleport beam, rings and sparks where he appears
    }
    const u = Math.min(1, (introT - b.spawnAt) / INTRO_RISE_S)
    const rise = 1 - Math.pow(1 - u, 3)
    Transform.getMutable(b.entity).position = Vector3.create(b.pos.x, b.pos.y - b.depth * (1 - rise), b.pos.z)
    face(b)
  }
  aimIntroCamera(Math.min(1, introT / solo.introDur))
  if (introT >= solo.introDur) endIntro()
}

// ---------------------------------------------------------------------------------------------------------------------
// Victory: the camera on the last boss to fall, with the winner image
// ---------------------------------------------------------------------------------------------------------------------

function aimVictoryCamera(u: number) {
  const b = lastDefeated ?? bosses[0]
  if (!b || !introCam) return
  const k = b.scale / VAMPIRE_SCALE
  const target = Vector3.create(b.pos.x, b.pos.y + b.bodyY * 0.85, b.pos.z)
  const e = u * u * (3 - 2 * u)
  const dist = (9 - 3.5 * e) * Math.max(1, k * 0.9)
  const ang = ((26 - 52 * e) * Math.PI) / 180 // a slow sweep around him, from the player's side
  const eye = Vector3.create(target.x + Math.sin(ang) * dist, target.y + 0.5 + 0.5 * e, target.z + Math.cos(ang) * dist)
  const t = Transform.getMutable(introCam)
  t.position = eye
  t.rotation = Quaternion.lookRotation(Vector3.subtract(target, eye))
}

function beginVictory() {
  ensureCam()
  victoryT = 0
  solo.victory = true
  solo.victoryAge = 0
  solo.victoryId++
  aimVictoryCamera(0)
  takeCamera()
}

function endVictory() {
  if (!solo.victory) return
  solo.victory = false
  dropCamera()
}

function updateVictory(dt: number) {
  victoryT += dt
  solo.victoryAge = victoryT
  aimVictoryCamera(Math.min(1, victoryT / solo.victoryDur))
  if (victoryT >= solo.victoryDur) endVictory()
}

// ---------------------------------------------------------------------------------------------------------------------
// The main loop
// ---------------------------------------------------------------------------------------------------------------------

/** What the server has for this player's status (a synced component). */
function myServerStatus(): string | undefined {
  const me = getPlayer()?.userId?.toLowerCase()
  if (!me) return undefined
  for (const [, p] of engine.getEntitiesWith(PlayerState)) if (p.playerId === me) return p.status
  return undefined
}

/** The boss whose turn it is (the attacks do not need him, but spawnTiles takes one). */
function c0(): Boss {
  return cur ?? bosses[0]
}

function fightSystem(dt: number) {
  // No answer from the server: say so (it is most likely still running the old scene code: restart the preview)
  if (solo.starting && Date.now() - startAskedAt > 4000) {
    solo.starting = false
    console.log('[SOLO] no answer from the server to soloStart')
    parryFeedback.notice('Server did not answer - restart the preview')
  }
  if (!solo.active || bosses.length === 0) return

  // If the server lost track of this run (it restarted, or cleared a stale status), tell it again (no teleport)
  const status = myServerStatus()
  if (status !== undefined && status !== 'solo' && !solo.starting) {
    if (outOfSyncSince === 0) outOfSyncSince = Date.now()
    if (Date.now() - outOfSyncSince > 3000 && Date.now() - lastAssertAt > 3000) {
      lastAssertAt = Date.now()
      console.log('[SOLO] server status is', status, '- re-asserting the run')
      room.send('soloStart', { seq: 1 })
    }
  } else {
    outOfSyncSince = 0
  }

  const player = playerPos()
  updateBossFx(dt)

  // The victory shot: the last boss finishes falling while the camera watches him
  if (solo.victory) {
    for (const b of bosses) bossLife(b, dt)
    updateVictory(dt)
    return
  }

  // The level intro: bosses rise out of the floor while the camera watches; nothing else happens yet
  if (solo.intro) {
    updateIntro(dt)
    return
  }

  for (const b of bosses) {
    bossLife(b, dt)
    if (b.hp <= 0 || b.act !== 'free') continue
    if (busyBoss(b)) face(b)
    else ambient(b, dt)
  }

  // Falling off the ring costs a heart and puts you back
  fallCooldown = Math.max(0, fallCooldown - dt)
  if (
    solo.phase === 'fight' &&
    player &&
    fallCooldown === 0 &&
    player.y < ARENA_FLOOR_Y - FALL_NET_DEPTH &&
    Math.hypot(player.x - ARENA_CENTER.x, player.z - ARENA_CENTER.z) <= ARENA_RADIUS + FALL_NET_RANGE
  ) {
    fallCooldown = FALL_COOLDOWN_S
    clearAll()
    phase = 'wait'
    timer = pause()
    if (!damagePlayer(Vector3.create(player.x, ARENA_FLOOR_Y + 1, player.z), 'You fell! ')) toSpawn()
    return
  }

  updateZone(dt)

  if (solo.phase === 'fight' && bosses.every((b) => b.hp <= 0)) {
    win()
    return
  }

  switch (phase) {
    case 'wait':
      timer -= dt
      if (timer <= 0) {
        // Every few attacks one is guaranteed to be a pumpkin, so a fight cannot drag on forever
        const force = sinceThrow >= forceAt
        const next = pickThrower(force)
        if (next) {
          const atk = nextAttack(next, force)
          if (isPumpkinAttack(atk)) {
            sinceThrow = 0
            forceAt = PUMPKIN_EVERY_MIN + (Math.random() < 0.5 ? 0 : PUMPKIN_EVERY_MAX - PUMPKIN_EVERY_MIN)
          } else {
            sinceThrow++
          }
          startAttack(next, atk)
        }
      }
      break

    case 'attack': {
      attackT += dt
      if (charging) {
        const c = charging
        c.t += dt
        const b = c.boss
        if (b.hp <= 0) {
          finishProj(c.proj)
          charging = undefined
        } else if (c.t >= VAMPIRE_BLAST_APPEAR_S) {
          // The pumpkin forms in his raised hand. Energy streams into it and it swells to full size by the throw.
          c.proj.pos = hand(b)
          const u = Math.min(1, (c.t - VAMPIRE_BLAST_APPEAR_S) / (VAMPIRE_BLAST_LAUNCH_S - VAMPIRE_BLAST_APPEAR_S))
          c.proj.size = PUMPKIN_CHARGE_START_SCALE + (1 - PUMPKIN_CHARGE_START_SCALE) * u * u * (3 - 2 * u)
          chargeFx(c.proj.pos, dt, u)
          if (c.t >= VAMPIRE_BLAST_LAUNCH_S) release(c)
        }
      }
      // Last stand: while pumpkins are in the air he keeps casting extra attacks (orbs, floor blasts, meteors) on top
      const v = lastStandBoss()
      if (v && !charging && v.act === 'free' && !busyBoss(v) && projs.some((p) => p.kind === 'real' && (p.state === 'hover' || p.state === 'fly' || p.state === 'back'))) {
        overlayT += dt
        if (overlayT >= OVERLAY_EVERY_S) {
          overlayT = 0
          castOverlay(v)
        }
      } else {
        overlayT = 0
      }

      // While a rally goes on, floor circles keep popping up around you
      const rt = level().rallyTiles
      if (rt && !charging && projs.some((p) => p.rally && p.state !== 'done')) {
        rallyTilesT += dt
        if (rallyTilesT >= rt.every) {
          rallyTilesT = 0
          playSfx(MAGIC_SPELL2_SFX, 0.8)
          spawnTiles(c0(), { kind: 'tiles', count: rt.count, radius: rt.radius, telegraph: rt.telegraph, aimed: true })
          tip('tiles', 'Floor attack! MOVE!')
        }
      } else if (!rt || charging) {
        rallyTilesT = 0
      }
      if (attackT > ATTACK_TIMEOUT_S) clearAll()
      if (!charging && projs.length === 0 && !hazards.some((h) => h.used)) {
        phase = 'wait'
        timer = pause()
      }
      break
    }

    case 'over':
      break
  }

  for (const p of projs) updateProj(p, dt)
  updateHazards(dt)
  for (const p of projs) drawProj(p)
  projs = projs.filter((p) => p.state !== 'done')
}
