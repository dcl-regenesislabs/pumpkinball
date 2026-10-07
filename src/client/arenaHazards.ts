import { Animator, engine, Entity, GltfContainer, Material, MeshRenderer, Transform } from '@dcl/sdk/ecs'
import { Color4, Quaternion, Vector3 } from '@dcl/sdk/math'
import {
  BLAST_FLASH_S,
  floorLifeS,
  HazardEntry,
  orbLifeS,
  orbPosition,
  PACING,
  RING_ARM_S,
  RING_HEIGHT,
  RING_SEGMENTS,
  RING_THICKNESS,
  ringProgress,
  ringRadius,
  ringSegmentOpen
} from '../shared/arenaHazards'
import {
  ARENA_CENTER,
  ARENA_FLOOR_Y,
  INTRO_RISE_S,
  NPC_RING_LIFT,
  NPC_RING_MODEL,
  NPC_RING_RADIUS,
  NPC_RING_SPIN_DEG_PER_S,
  PUMPKIN_MODEL,
  PUMPKIN_MODEL_OFFSET_Y,
  PUMPKIN_MODEL_SCALE,
  PlayerStatus,
  PUMPKIN_TUMBLE_DEG_PER_S,
  VAMPIRE_CLIPS,
  VAMPIRE_SCALE
} from '../shared/config'
import { getPlayer } from '@dcl/sdk/src/players'
import { ArenaHazards, PlayerState } from '../shared/schemas'
import { handHeight, NPCS } from '../shared/soloLevels'
import { findAvatar } from './avatars'
import { blastFx, chargeFx, decoyTrail, parryBurst, spawnFx, trailBubble } from './effects'
import { parryFeedback } from './feedback'
import { BAT_HIT_SFX, HURT_SFX, MAGIC_SPELL2_SFX, MAGIC_SPELL_SFX, playSfx, playSfxAt, PUMPKIN_CAST_SFX, SWING_SFX, VAMPIRE_VOICE_SFX } from './sfx'
import { glow, setAlpha } from './solo'
import { hasServerTime, serverNow, updateServerTime } from './serverTime'
import { solo } from './soloState'

/**
 * Draws the Vampire's hazards in a multiplayer round (see shared/arenaHazards.ts) for everyone: the players, the ones who are
 * out and the lobby. All of it comes from the server's list of entries; nothing here decides who is hit. A player in their own
 * solo run does not see it (their ring is a different game).
 */

const VAMPIRE_MULT = 1.25 // the Vampire Master's size in the solo run
const HAZARD_Y = ARENA_FLOOR_Y + 0.06
const METEOR_ARC_HEIGHT = 3.2
const ORB_SIZE = 0.8
// Pool sizes: a late round has two casts overlapping and up to four rings at once. A full pool just skips the drawing, never the hit.
const MAX_TILES = 32
const MAX_PUMPKINS = 12
const MAX_ORBS = 20
const MAX_RINGS = 5
const FRESH_S = 3 // an entry or the Vampire seen for the first time this soon after it started plays its sound, effects and tip

const HAZARD_EDGE = Color4.create(1, 0.15, 0.05, 1)
const HAZARD_FILL = Color4.create(1, 0.55, 0.05, 1)
const RING_COLOR = Color4.create(1, 0.2, 0.1, 1)
const ORB_COLOR = Color4.create(0.2, 1, 0.1, 1)
const TAU = Math.PI * 2

interface TileSlot {
  edge: Entity
  fill: Entity
  used: boolean
}
interface BodySlot {
  body: Entity
  used: boolean
}
interface RingSlot {
  segs: Entity[]
  used: boolean
}

/** What one entry is drawn with. */
interface Viz {
  tile?: TileSlot
  pumpkin?: BodySlot
  orb?: BodySlot
  ring?: RingSlot
  blasted: boolean
  styled: boolean // the circle's fixed position, size of its edge and colour are set (they never change while it charges)
  ringSolid: boolean // a ring's fade-in is over: its colour is set for good
  segShown: boolean[] // which pieces of a ring are currently drawn, so only changes are written
  ringDrawnAt: number // age (s) of a ring's last redraw
  launched: boolean // an orb's launch sound has played
  trailAt?: Vector3
  lastPos: Vector3
  lastAge: number
  life: number // seconds an orb flies before it fizzles at the edge
  spin: number
}

interface Vampire {
  entity: Entity
  marker: Entity
  scale: number
  depth: number
  handY: number
  spawned: boolean
  castRelease: number // server ms the current cast is released (the charge ends)
  castKind: string
  released: boolean
  castUntil: number // local ms the cast animation ends
  facing: { x: number; z: number } // where his last cast was aimed (the hand and the cast turn use it)
  yaw: number // radians, the way he is turned (atan2(x, z))
  mode: 'spin' | 'look'
  modeT: number // seconds left in this mode
  lookId: string
}

let tiles: TileSlot[] = []
let pumpkins: BodySlot[] = []
let orbs: BodySlot[] = []
let rings: RingSlot[] = []
let built = false
let vamp: Vampire | undefined
const viz = new Map<number, Viz>()
const seenCasts = new Set<number>()
const tipped = new Set<string>()
let markerSpin = 0

const IDLE_CLIP = 'levitate_idle' // he floats while he waits
const CLIPS = [IDLE_CLIP, 'blast_left']
const SPIN_RAD_S = 2.2 // turning on the spot, about 125 degrees a second
const LOOK_TURN_RAD_S = 4 // swinging round to face a player
const SPIN_FOR_S = { min: 1.5, max: 3 } // he alternates: spins for a while, then stares at one player for a while
const LOOK_FOR_S = { min: 2.5, max: 4.5 }

function tip(key: string, text: string) {
  if (tipped.has(key)) return
  tipped.add(key)
  parryFeedback.notice(text)
}

function centerAt(y: number) {
  return Vector3.create(ARENA_CENTER.x, y, ARENA_CENTER.z)
}

function hand(v: Vampire): Vector3 {
  return Vector3.create(ARENA_CENTER.x + v.facing.x * 0.5, ARENA_FLOOR_Y + v.handY, ARENA_CENTER.z + v.facing.z * 0.5)
}

// ---------------------------------------------------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------------------------------------------------

function build() {
  if (built) return
  built = true
  for (let i = 0; i < MAX_TILES; i++) {
    const edge = engine.addEntity()
    Transform.create(edge, { scale: Vector3.Zero() })
    MeshRenderer.setCylinder(edge)
    glow(edge, HAZARD_EDGE, 0.9)
    const fill = engine.addEntity()
    Transform.create(fill, { scale: Vector3.Zero() })
    MeshRenderer.setCylinder(fill)
    glow(fill, HAZARD_FILL, 1.0)
    tiles.push({ edge, fill, used: false })
  }
  for (let i = 0; i < MAX_PUMPKINS; i++) {
    const body = engine.addEntity()
    Transform.create(body, { scale: Vector3.Zero() })
    const model = engine.addEntity()
    Transform.create(model, {
      parent: body,
      position: Vector3.create(0, PUMPKIN_MODEL_OFFSET_Y, 0),
      scale: Vector3.create(PUMPKIN_MODEL_SCALE, PUMPKIN_MODEL_SCALE, PUMPKIN_MODEL_SCALE)
    })
    GltfContainer.create(model, { src: PUMPKIN_MODEL })
    pumpkins.push({ body, used: false })
  }
  for (let i = 0; i < MAX_ORBS; i++) {
    const body = engine.addEntity()
    Transform.create(body, { scale: Vector3.Zero() })
    MeshRenderer.setSphere(body)
    Material.setPbrMaterial(body, { albedoColor: Color4.create(0.05, 0.3, 0.02, 1), emissiveColor: ORB_COLOR, emissiveIntensity: 1.2 })
    orbs.push({ body, used: false })
  }
  for (let r = 0; r < MAX_RINGS; r++) {
    const segs: Entity[] = []
    for (let i = 0; i < RING_SEGMENTS; i++) {
      const e = engine.addEntity()
      Transform.create(e, { scale: Vector3.Zero() })
      MeshRenderer.setBox(e)
      glow(e, RING_COLOR, 1.5)
      segs.push(e)
    }
    rings.push({ segs, used: false })
  }
}

function teardown(withFx: boolean) {
  if (vamp) {
    if (withFx) spawnFx(centerAt(ARENA_FLOOR_Y)) // he vanishes the way he came
    engine.removeEntity(vamp.entity)
    engine.removeEntity(vamp.marker)
    vamp = undefined
  }
  if (built) {
    for (const t of tiles) {
      engine.removeEntity(t.edge)
      engine.removeEntity(t.fill)
    }
    for (const p of pumpkins) engine.removeEntity(p.body) // the model hangs off it and goes with it
    for (const o of orbs) engine.removeEntity(o.body)
    for (const r of rings) for (const e of r.segs) engine.removeEntity(e)
    tiles = []
    pumpkins = []
    orbs = []
    rings = []
    built = false
  }
  viz.clear()
  seenCasts.clear()
  tipped.clear()
}

function release(v: Viz) {
  if (v.tile) {
    v.tile.used = false
    Transform.getMutable(v.tile.edge).scale = Vector3.Zero()
    Transform.getMutable(v.tile.fill).scale = Vector3.Zero()
  }
  for (const b of [v.pumpkin, v.orb]) {
    if (!b) continue
    b.used = false
    Transform.getMutable(b.body).scale = Vector3.Zero()
  }
  if (v.ring) {
    v.ring.used = false
    for (const e of v.ring.segs) Transform.getMutable(e).scale = Vector3.Zero()
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The Vampire
// ---------------------------------------------------------------------------------------------------------------------

function createVampire(): Vampire {
  const npc = NPCS.Vampire
  const scale = VAMPIRE_SCALE * VAMPIRE_MULT
  const depth = npc.height * scale * 1.15
  const entity = engine.addEntity()
  Transform.create(entity, {
    position: Vector3.create(ARENA_CENTER.x, ARENA_FLOOR_Y - depth, ARENA_CENTER.z),
    rotation: Quaternion.lookRotation(Vector3.create(0, 0, 1)),
    scale: Vector3.create(scale, scale, scale)
  })
  GltfContainer.create(entity, { src: npc.model, visibleMeshesCollisionMask: 0, invisibleMeshesCollisionMask: 0 })
  Animator.create(entity, { states: CLIPS.map((clip) => ({ clip, playing: clip === IDLE_CLIP, loop: clip === IDLE_CLIP })) })
  const marker = engine.addEntity()
  Transform.create(marker, { position: Vector3.create(ARENA_CENTER.x, ARENA_FLOOR_Y + NPC_RING_LIFT, ARENA_CENTER.z), scale: Vector3.Zero() })
  GltfContainer.create(marker, { src: NPC_RING_MODEL, visibleMeshesCollisionMask: 0, invisibleMeshesCollisionMask: 0 })
  return {
    entity,
    marker,
    scale,
    depth,
    handY: handHeight(npc, scale),
    spawned: false,
    castRelease: 0,
    castKind: '',
    released: true,
    castUntil: 0,
    facing: { x: 0, z: 1 },
    yaw: 0,
    mode: 'spin',
    modeT: 1,
    lookId: ''
  }
}

/** A random alive player's position (a spot to stare at), if anyone is on the arena. */
function pickLook(v: Vampire) {
  const ids: string[] = []
  for (const [, p] of engine.getEntitiesWith(PlayerState)) if (p.status === PlayerStatus.Alive) ids.push(p.playerId)
  v.lookId = ids.length > 0 ? ids[Math.floor(Math.random() * ids.length)] : ''
}

function lookTarget(v: Vampire): { x: number; z: number } | undefined {
  const entity = v.lookId ? findAvatar(v.lookId, getPlayer()?.userId?.toLowerCase()) : undefined
  const pos = entity !== undefined ? Transform.getOrNull(entity)?.position : undefined
  return pos ? { x: pos.x, z: pos.z } : undefined
}

/** Where he faces: toward his cast while casting, otherwise spinning for a while and then staring at one player, over and over. Not exact on purpose. */
function turn(v: Vampire, dt: number) {
  const casting = !v.released || v.castUntil > 0
  let want: number | undefined
  if (casting) {
    want = Math.atan2(v.facing.x, v.facing.z)
  } else {
    v.modeT -= dt
    if (v.modeT <= 0) {
      if (v.mode === 'spin') pickLook(v)
      const spinNext = v.mode === 'look' || lookTarget(v) === undefined
      v.mode = spinNext ? 'spin' : 'look'
      const span = spinNext ? SPIN_FOR_S : LOOK_FOR_S
      v.modeT = span.min + Math.random() * (span.max - span.min)
    }
    if (v.mode === 'spin') {
      v.yaw += SPIN_RAD_S * dt
      return
    }
    const target = lookTarget(v)
    if (target) want = Math.atan2(target.x - ARENA_CENTER.x, target.z - ARENA_CENTER.z)
    else v.modeT = 0
  }
  if (want === undefined) return
  let diff = (want - v.yaw) % TAU
  if (diff > Math.PI) diff -= TAU
  if (diff < -Math.PI) diff += TAU
  const step = LOOK_TURN_RAD_S * dt
  v.yaw += Math.abs(diff) <= step ? diff : Math.sign(diff) * step
}

function updateVampire(vampireAt: number, now: number, dt: number) {
  if (vampireAt <= 0) {
    if (vamp) {
      engine.removeEntity(vamp.entity)
      engine.removeEntity(vamp.marker)
      vamp = undefined
    }
    return
  }
  const age = (now - vampireAt) / 1000
  if (!vamp) vamp = createVampire()
  const v = vamp
  if (!v.spawned) {
    v.spawned = true
    if (age < FRESH_S) {
      spawnFx(centerAt(ARENA_FLOOR_Y))
      playSfx(MAGIC_SPELL_SFX, 0.9)
      playSfx(VAMPIRE_VOICE_SFX, 0.9)
      tip('vampire', 'The Vampire awakens!')
    }
  }
  const u = Math.min(1, Math.max(0, age / INTRO_RISE_S))
  const rise = 1 - Math.pow(1 - u, 3)
  const t = Transform.getMutable(v.entity)
  t.position = Vector3.create(ARENA_CENTER.x, ARENA_FLOOR_Y - v.depth * (1 - rise), ARENA_CENTER.z)
  turn(v, dt)
  t.rotation = Quaternion.fromEulerDegrees(0, (v.yaw * 180) / Math.PI, 0)

  markerSpin = (markerSpin + NPC_RING_SPIN_DEG_PER_S * dt) % 360
  const r = NPC_RING_RADIUS * VAMPIRE_MULT * (1 + Math.sin((Date.now() / 1000) * 6) * 0.06) * rise
  const m = Transform.getMutable(v.marker)
  m.rotation = Quaternion.fromEulerDegrees(0, markerSpin, 0)
  m.scale = Vector3.create(r, 1, r)

  // Charging a cast: energy streams into his hand until the attack is released
  if (!v.released) {
    if (now >= v.castRelease) {
      v.released = true
      parryBurst(hand(v))
      playSfx(SWING_SFX, 0.9) // the release, and then what the attack itself sounds like in solo
      if (v.castKind === 'orb') playSfx(MAGIC_SPELL_SFX, 0.85)
      else if (v.castKind === 'tile') playSfx(MAGIC_SPELL2_SFX, 0.9)
    } else {
      chargeFx(hand(v), dt, Math.min(1, Math.max(0, 1 - (v.castRelease - now) / (PACING.castS * 1000))))
    }
  }
  if (v.castUntil > 0 && Date.now() >= v.castUntil) {
    v.castUntil = 0
    Animator.playSingleAnimation(v.entity, IDLE_CLIP, true)
  }
}

/** A new cast: he turns toward it and plays the cast animation, with its sound. */
function beginCast(e: HazardEntry) {
  if (!vamp) return
  const v = vamp
  const dx = e.kind === 'orb' ? e.a : e.x - ARENA_CENTER.x
  const dz = e.kind === 'orb' ? e.b : e.z - ARENA_CENTER.z
  const len = Math.hypot(dx, dz) || 1
  v.facing = { x: dx / len, z: dz / len }
  v.castRelease = e.t0
  v.castKind = e.kind
  v.released = false
  v.castUntil = Date.now() + VAMPIRE_CLIPS.blast_left * 1000
  Animator.playSingleAnimation(v.entity, 'blast_left', true)
  playSfx(PUMPKIN_CAST_SFX, 0.9) // every attack charges with the pumpkin cast sound (flat, like solo: everyone hears it)
  tip(e.kind, e.kind === 'orb' ? 'DODGE the green orbs!' : e.kind === 'meteor' ? 'Explosive pumpkins! MOVE!' : 'Floor attack! MOVE!')
}

// ---------------------------------------------------------------------------------------------------------------------
// Drawing the entries
// ---------------------------------------------------------------------------------------------------------------------

function slotFor<T extends { used: boolean }>(pool: T[]): T | undefined {
  const s = pool.find((x) => !x.used)
  if (s) s.used = true
  return s
}

function drawFloor(e: HazardEntry, v: Viz, age: number) {
  const hz = vamp ? hand(vamp) : centerAt(ARENA_FLOOR_Y + 4)
  const t = v.tile
  if (e.kind === 'meteor') {
    v.pumpkin ??= slotFor(pumpkins)
    const p = v.pumpkin
    if (p) {
      const u = Math.min(1, Math.max(0, age / e.b))
      const pos =
        age < 0 || age >= e.b
          ? hz
          : Vector3.create(
              hz.x + (e.x - hz.x) * u,
              hz.y + (ARENA_FLOOR_Y + 0.5 - hz.y) * u + Math.sin(Math.PI * u) * METEOR_ARC_HEIGHT,
              hz.z + (e.z - hz.z) * u
            )
      const pt = Transform.getMutable(p.body)
      if (age >= e.b || !vamp) pt.scale = Vector3.Zero() // landed, or he is not up yet
      else {
        pt.position = pos
        pt.rotation = Quaternion.fromEulerDegrees(
          (v.spin * PUMPKIN_TUMBLE_DEG_PER_S.x) % 360,
          (v.spin * PUMPKIN_TUMBLE_DEG_PER_S.y) % 360,
          (v.spin * PUMPKIN_TUMBLE_DEG_PER_S.z) % 360
        )
        pt.scale = Vector3.One()
        if (age >= 0 && Math.floor(age * 20) !== Math.floor((age - 0.05) * 20)) trailBubble(pos)
      }
    }
  }
  if (age < 0) return
  if (!t) return
  const fillT = Transform.getMutable(t.fill)
  const d = e.a * 2
  if (age < e.b) {
    // Only the fill's size changes while it charges; position and colour are set once (a colour write is the costly part)
    if (!v.styled) {
      v.styled = true
      const edgeT = Transform.getMutable(t.edge)
      edgeT.position = Vector3.create(e.x, HAZARD_Y, e.z)
      edgeT.scale = Vector3.create(d, 0.03, d)
      fillT.position = Vector3.create(e.x, HAZARD_Y + 0.02, e.z)
      setAlpha(t.edge, 0.35)
      setAlpha(t.fill, 0.55)
    }
    const fd = Math.max(0.05, d * (age / e.b))
    fillT.scale = Vector3.create(fd, 0.03, fd)
  } else {
    if (!v.blasted) {
      v.blasted = true
      fillT.scale = Vector3.create(d, 0.03, d)
      setAlpha(t.fill, 0.9)
      setAlpha(t.edge, 0.5)
      if (age < e.b + 1) {
        const c = Vector3.create(e.x, ARENA_FLOOR_Y, e.z)
        blastFx(c, e.a)
        playSfxAt(BAT_HIT_SFX, c, 1)
        playSfxAt(HURT_SFX, c, 0.6)
      }
    }
    if (age - e.b >= BLAST_FLASH_S && fillT.scale.x > 0) {
      Transform.getMutable(t.edge).scale = Vector3.Zero()
      fillT.scale = Vector3.Zero()
    }
  }
}

function drawOrb(e: HazardEntry, v: Viz, age: number) {
  const o = v.orb
  if (!o) return
  const t = Transform.getMutable(o.body)
  if (age < 0 || age > orbLifeS(e)) {
    t.scale = Vector3.Zero()
    return
  }
  if (!v.launched) {
    v.launched = true
    if (age < 1) playSfx(MAGIC_SPELL2_SFX, 0.62) // each orb as it leaves him, like solo
  }
  const pos = orbPosition(e, age)
  const at = Vector3.create(pos.x, pos.y + Math.sin(v.spin * 7) * 0.07, pos.z)
  t.position = at
  const s = ORB_SIZE * (1 + 0.1 * Math.sin(v.spin * 14))
  t.scale = Vector3.create(s, s, s)
  // trail sparks spaced by distance
  if (!v.trailAt) v.trailAt = Vector3.create(pos.x, pos.y, pos.z)
  else if (Vector3.distance(v.trailAt, at) >= 0.35) {
    decoyTrail(at)
    v.trailAt = at
  }
  v.lastPos = Vector3.create(pos.x, pos.y, pos.z)
}

const RING_ALPHA = 0.6
const RING_REDRAW_S = 0.1 // a ring crawls (well under 0.5 m/s), so it is redrawn ten times a second, not every frame

function drawRing(e: HazardEntry, v: Viz, age: number) {
  const ring = v.ring
  if (!ring || (v.ringDrawnAt >= 0 && age - v.ringDrawnAt < RING_REDRAW_S)) return
  v.ringDrawnAt = age
  const u = ringProgress(e, age)
  const r = ringRadius(u)
  const arc = ((TAU * r) / RING_SEGMENTS) * 1.04
  const fade = Math.min(1, age / RING_ARM_S) // a new ring fades in before it burns
  const recolor = !v.ringSolid
  if (fade >= 1) v.ringSolid = true
  ring.segs.forEach((seg, i) => {
    if (recolor) setAlpha(seg, RING_ALPHA * (0.25 + 0.75 * fade))
    if (age < 0 || u >= 1 || ringSegmentOpen(e, age, i)) {
      if (v.segShown[i]) {
        Transform.getMutable(seg).scale = Vector3.Zero()
        v.segShown[i] = false
      }
      return
    }
    const a = (i / RING_SEGMENTS) * TAU
    const t = Transform.getMutable(seg)
    t.position = Vector3.create(ARENA_CENTER.x + Math.cos(a) * r, ARENA_FLOOR_Y + RING_HEIGHT / 2, ARENA_CENTER.z + Math.sin(a) * r)
    t.rotation = Quaternion.lookRotation(Vector3.create(-Math.sin(a), 0, Math.cos(a)))
    t.scale = Vector3.create(RING_THICKNESS, RING_HEIGHT, arc)
    v.segShown[i] = true
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// Every frame
// ---------------------------------------------------------------------------------------------------------------------

/** Past its life: the server only prunes its list every few seconds, so each client lets go of an entry itself. */
function expired(e: HazardEntry, age: number): boolean {
  if (e.kind === 'orb') return age > orbLifeS(e)
  if (e.kind === 'ring') return ringProgress(e, age) >= 1
  return age > floorLifeS(e)
}

function update(dt: number) {
  updateServerTime()
  let comp: { active: boolean; vampireAt: number; entries: readonly HazardEntry[] } | undefined
  for (const [, c] of engine.getEntitiesWith(ArenaHazards)) comp = c
  const on = comp !== undefined && comp.active && !solo.active && hasServerTime()
  if (!on || !comp) {
    if (built || vamp) teardown(comp !== undefined && !comp.active && !solo.active && vamp !== undefined)
    return
  }
  build()
  const now = serverNow()
  updateVampire(comp.vampireAt, now, dt)

  const present = new Set<number>()
  for (const e of comp.entries) {
    const age = (now - e.t0) / 1000
    if (expired(e, age)) continue // the server only tidies its list now and then
    present.add(e.id)
    let v = viz.get(e.id)
    if (!v) {
      v = { blasted: false, styled: false, ringSolid: false, segShown: [], ringDrawnAt: -1, launched: false, lastPos: Vector3.Zero(), lastAge: 0, life: e.kind === 'orb' ? orbLifeS(e) : 0, spin: Math.random() * 6 }
      if (e.kind === 'tile' || e.kind === 'meteor') v.tile = slotFor(tiles)
      else if (e.kind === 'orb') v.orb = slotFor(orbs)
      else if (e.kind === 'ring') {
        v.ring = slotFor(rings)
        if (age < FRESH_S) tip('ring', 'Fire rings! Cross through the gaps!')
      }
      viz.set(e.id, v)
    }
    if (e.kind !== 'ring' && !seenCasts.has(e.cast)) {
      seenCasts.add(e.cast)
      if (age < 0.5) beginCast(e)
    }
    v.spin += dt
    v.lastAge = age
    if (e.kind === 'tile' || e.kind === 'meteor') drawFloor(e, v, age)
    else if (e.kind === 'orb') drawOrb(e, v, age)
    else if (e.kind === 'ring') drawRing(e, v, age)
  }

  // Entries the server removed: an orb that was spent on a player bursts where it was
  for (const [id, v] of viz) {
    if (present.has(id)) continue
    if (v.orb && v.lastAge > 0 && v.lastAge < v.life - 0.25) parryBurst(v.lastPos)
    release(v)
    viz.delete(id)
  }
}

export function setupArenaHazards() {
  engine.addSystem(update)
}
