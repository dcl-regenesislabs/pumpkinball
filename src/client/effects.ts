import { engine, Entity, Material, MaterialTransparencyMode, MeshRenderer, Transform } from '@dcl/sdk/ecs'
import { Color4, Vector3 } from '@dcl/sdk/math'
import { ARENA_CENTER, ARENA_RADIUS, LAVA_SURFACE_Y } from '../shared/config'
import { isOnLava, randomLavaPoint } from '../shared/lava'

/**
 * Particle-like effects without the particle component: a fixed pool of small glowing spheres that
 * are recycled and animated by one system. Each sphere grows in and shrinks away ("bubbles").
 */

type Kind = 'trail' | 'splash' | 'parry' | 'lava'

interface Bubble {
  entity: Entity
  active: boolean
  age: number
  life: number
  size: number
  gravity: number
  drag: number
  px: number
  py: number
  pz: number
  vx: number
  vy: number
  vz: number
}

const PALETTE: Record<Kind, Color4[]> = {
  trail: [Color4.create(0.6, 0.2, 1, 1), Color4.create(0.82, 0.45, 1, 1)], // purple
  splash: [Color4.create(0.85, 0, 0.02, 1), Color4.create(1, 0.08, 0.05, 1)], // red
  parry: [Color4.create(1, 0.5, 0, 1), Color4.create(1, 0.7, 0.1, 1)], // orange only
  lava: [Color4.create(0.15, 1, 0.05, 1), Color4.create(0.35, 1, 0.12, 1)] // saturated neon green (kept away from white so the glow doesn't wash out)
}
const GLOW: Record<Kind, number> = { trail: 2.2, splash: 2.2, parry: 2.2, lava: 1.0 } // lava is much lower: above ~1.5 the green clips to white
const POOL_SIZE: Record<Kind, number> = { trail: 72, splash: 40, parry: 64, lava: 120 }

const pools: Record<Kind, Bubble[]> = { trail: [], splash: [], parry: [], lava: [] }
const cursor: Record<Kind, number> = { trail: 0, splash: 0, parry: 0, lava: 0 }

const rand = (min: number, max: number) => min + Math.random() * (max - min)

function createPool(kind: Kind) {
  for (let i = 0; i < POOL_SIZE[kind]; i++) {
    const entity = engine.addEntity()
    Transform.create(entity, { scale: Vector3.Zero() })
    MeshRenderer.setSphere(entity)
    const color = PALETTE[kind][i % PALETTE[kind].length]
    // Lava bubbles get a dark green base, so the glow (not a bright base colour) carries the green.
    const base = kind === 'lava' ? Color4.create(0.02, 0.2, 0.01, 1) : color
    Material.setPbrMaterial(entity, { albedoColor: base, emissiveColor: color, emissiveIntensity: GLOW[kind] })
    pools[kind].push({
      entity,
      active: false,
      age: 0,
      life: 1,
      size: 0.2,
      gravity: 0,
      drag: 0,
      px: 0,
      py: 0,
      pz: 0,
      vx: 0,
      vy: 0,
      vz: 0
    })
  }
}

function spawn(kind: Kind, pos: Vector3, vel: Vector3, life: number, size: number, gravity = 0, drag = 0) {
  const pool = pools[kind]
  if (pool.length === 0) return
  // Round-robin: when the pool is full the oldest bubble is reused.
  const b = pool[cursor[kind] % pool.length]
  cursor[kind]++
  b.active = true
  b.age = 0
  b.life = life
  b.size = size
  b.gravity = gravity
  b.drag = drag
  b.px = pos.x
  b.py = pos.y
  b.pz = pos.z
  b.vx = vel.x
  b.vy = vel.y
  b.vz = vel.z
}

// ---- Teleport VFX: a glowing beam shoots up with two rings expanding and rising, and purple sparkles fly up ----
// Built from SDK shapes (cylinders) with fading materials, in a small pool of slots that are recycled. One slot plays
// at the spot a player leaves and another where they arrive.

interface TeleportSlot {
  beam: Entity
  rings: Entity[]
  active: boolean
  age: number
  at: Vector3
}
const TELEPORT_SLOTS = 12
const TELEPORT_LIFE = 0.95
const TELEPORT_GLOW = 0.9 // emissive strength; raise it for a brighter glow, lower for deeper colour
const BEAM_COLOR = Color4.create(0.6, 0.25, 1, 1) // purple, like the pillar flames
const RING_COLOR = Color4.create(0.3, 1, 0.3, 1) // neon green, like the lava
const teleportSlots: TeleportSlot[] = []
let teleportCursor = 0

function glowMaterial(entity: Entity, color: Color4) {
  Material.setPbrMaterial(entity, {
    // Dark base and a low glow: above about 1.5 the colour clips to white (same as the lava lights)
    albedoColor: Color4.create(color.r * 0.3, color.g * 0.3, color.b * 0.3, 0),
    emissiveColor: color,
    emissiveIntensity: TELEPORT_GLOW,
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND
  })
}

function setGlowAlpha(entity: Entity, alpha: number) {
  const m = Material.getMutable(entity)
  if (m.material?.$case === 'pbr' && m.material.pbr.albedoColor) {
    const c = m.material.pbr.albedoColor
    m.material.pbr.albedoColor = Color4.create(c.r, c.g, c.b, alpha)
  }
}

function createTeleportSlots() {
  for (let i = 0; i < TELEPORT_SLOTS; i++) {
    const beam = engine.addEntity()
    Transform.create(beam, { scale: Vector3.Zero() })
    MeshRenderer.setCylinder(beam)
    glowMaterial(beam, BEAM_COLOR)
    const rings: Entity[] = []
    for (let k = 0; k < 2; k++) {
      const ring = engine.addEntity()
      Transform.create(ring, { scale: Vector3.Zero() })
      MeshRenderer.setCylinder(ring)
      glowMaterial(ring, RING_COLOR)
      rings.push(ring)
    }
    teleportSlots.push({ beam, rings, active: false, age: 0, at: Vector3.Zero() })
  }
}

/** Plays the teleport effect at a spot (call it where a player leaves and where they arrive). */
export function teleportFx(at: Vector3) {
  const slot = teleportSlots[teleportCursor % teleportSlots.length]
  teleportCursor++
  if (!slot) return
  slot.active = true
  slot.age = 0
  slot.at = Vector3.create(at.x, at.y, at.z)
  for (let i = 0; i < 10; i++) {
    const angle = rand(0, Math.PI * 2)
    const r = rand(0.1, 0.4)
    spawn(
      i % 2 === 0 ? 'trail' : 'lava', // purple and green sparks
      Vector3.create(at.x + Math.cos(angle) * r, at.y + 0.1, at.z + Math.sin(angle) * r),
      Vector3.create(Math.cos(angle) * rand(0.2, 0.7), rand(1.8, 3.4), Math.sin(angle) * rand(0.2, 0.7)),
      rand(0.45, 0.75),
      rand(0.08, 0.14),
      -1 // slight upward drift instead of falling: they rise like sparks
    )
  }
}

function updateTeleportFx(dt: number) {
  for (const slot of teleportSlots) {
    if (!slot.active) continue
    slot.age += dt
    const u = slot.age / TELEPORT_LIFE
    if (u >= 1) {
      slot.active = false
      Transform.getMutable(slot.beam).scale = Vector3.Zero()
      for (const ring of slot.rings) Transform.getMutable(ring).scale = Vector3.Zero()
      continue
    }
    // beam: shoots up fast, holds, then thins away
    const grow = 1 - Math.pow(1 - Math.min(1, slot.age / 0.22), 3)
    const thin = u < 0.4 ? 1 : 1 - (u - 0.4) / 0.6
    const height = 2.1 * grow
    const width = 0.55 * thin
    const beam = Transform.getMutable(slot.beam)
    beam.position = Vector3.create(slot.at.x, slot.at.y + height / 2, slot.at.z)
    beam.scale = Vector3.create(Math.max(0.001, width), Math.max(0.001, height), Math.max(0.001, width))
    setGlowAlpha(slot.beam, 0.55 * (1 - u))

    // two rings, the second a beat later: they widen and climb the beam
    slot.rings.forEach((ring, k) => {
      const ru = Math.min(1, Math.max(0, (slot.age - k * 0.14) / 0.6))
      const t = Transform.getMutable(ring)
      if (ru <= 0 || ru >= 1) {
        t.scale = Vector3.Zero()
        return
      }
      const radius = 0.25 + 0.95 * (1 - Math.pow(1 - ru, 2))
      t.position = Vector3.create(slot.at.x, slot.at.y + 0.08 + ru * (0.7 + k * 0.4), slot.at.z)
      t.scale = Vector3.create(radius * 2, 0.04, radius * 2)
      setGlowAlpha(ring, 0.8 * (1 - ru))
    })
  }
}

export function setupEffects() {
  createPool('trail')
  createPool('splash')
  createPool('parry')
  createPool('lava')
  createTeleportSlots()

  engine.addSystem((dt: number) => {
    updateTeleportFx(dt)
    for (const kind of ['trail', 'splash', 'parry', 'lava'] as Kind[]) {
      for (const b of pools[kind]) {
        if (!b.active) continue
        b.age += dt
        const t = b.age / b.life
        const tr = Transform.getMutable(b.entity)
        if (t >= 1) {
          b.active = false
          tr.scale = Vector3.Zero()
          continue
        }
        b.vy -= b.gravity * dt
        const damp = Math.max(0, 1 - b.drag * dt)
        b.vx *= damp
        b.vy *= damp
        b.vz *= damp
        b.px += b.vx * dt
        b.py += b.vy * dt
        b.pz += b.vz * dt
        tr.position = Vector3.create(b.px, b.py, b.pz)
        const s = b.size * Math.sin(Math.PI * t) // pops in, then shrinks away
        tr.scale = Vector3.create(s, s, s)
      }
    }
  })
}

// ---- Pumpkin trail: purple bubbles left along the path, spaced by distance so speed doesn't thin it out ----

const TRAIL_SPACING = 0.35 // metres between bubbles
let lastTrail: Vector3 | undefined

export function trailReset() {
  lastTrail = undefined
}

export function trail(at: Vector3) {
  if (!lastTrail) {
    lastTrail = Vector3.clone(at)
    return
  }
  const dist = Vector3.distance(lastTrail, at)
  if (dist < TRAIL_SPACING) return
  const steps = Math.min(5, Math.floor(dist / TRAIL_SPACING))
  for (let i = 1; i <= steps; i++) {
    const p = Vector3.lerp(lastTrail, at, i / steps)
    spawn(
      'trail',
      Vector3.create(p.x + rand(-0.18, 0.18), p.y + rand(-0.18, 0.18), p.z + rand(-0.18, 0.18)),
      Vector3.create(rand(-0.3, 0.3), rand(0.2, 0.7), rand(-0.3, 0.3)),
      rand(0.45, 0.8),
      rand(0.14, 0.26)
    )
  }
  lastTrail = Vector3.clone(at)
}

// ---- Hit: a red fountain out of the player ----

export function splash(at: Vector3) {
  for (let i = 0; i < 22; i++) {
    const angle = rand(0, Math.PI * 2)
    const out = rand(1, 3.2)
    spawn(
      'splash',
      Vector3.create(at.x, at.y, at.z),
      Vector3.create(Math.cos(angle) * out, rand(3, 6), Math.sin(angle) * out),
      rand(0.55, 0.95),
      rand(0.2, 0.36),
      11 // gravity: the blobs arc and fall
    )
  }
}

// ---- Lava splash: a player falls into the lava. A big green fountain with a few red embers ----

export function lavaSplash(at: Vector3) {
  for (let i = 0; i < 30; i++) {
    const angle = rand(0, Math.PI * 2)
    const out = rand(1.5, 4.5)
    spawn('lava', at, Vector3.create(Math.cos(angle) * out, rand(5, 10), Math.sin(angle) * out), rand(0.9, 1.5), rand(0.35, 0.85), 14)
  }
  for (let i = 0; i < 14; i++) {
    const angle = rand(0, Math.PI * 2)
    const out = rand(1, 3.5)
    spawn('splash', at, Vector3.create(Math.cos(angle) * out, rand(4, 8), Math.sin(angle) * out), rand(0.7, 1.2), rand(0.2, 0.4), 12)
  }
}

// ---- Successful parry: an orange shockwave ring plus a few sparks (clearly different from a hit) ----

/** A small orange puff when a lobby pumpkin dummy gets whacked: a few blobs fly off in the direction of the hit. */
export function dummyBurst(at: Vector3, dirX: number, dirZ: number, scale = 1, count = 9) {
  for (let i = 0; i < count; i++) {
    const spread = rand(-0.9, 0.9) // fan around the knock direction
    const c = Math.cos(spread)
    const s = Math.sin(spread)
    const out = rand(2.5, 5)
    spawn(
      'parry',
      Vector3.create(at.x, at.y, at.z),
      Vector3.create((dirX * c - dirZ * s) * out * scale, rand(1.5, 4) * Math.sqrt(scale), (dirX * s + dirZ * c) * out * scale),
      rand(0.3, 0.5),
      rand(0.1, 0.17) * scale,
      9, // gravity: they arc and drop
      1.5
    )
  }
}

/** A couple of purple blobs left behind a flying object (the boomerang pumpkins). */
export function flightPuff(at: Vector3, size = 0.2) {
  for (let i = 0; i < 2; i++) {
    spawn(
      'trail',
      Vector3.create(at.x + rand(-0.3, 0.3), at.y + rand(-0.3, 0.3), at.z + rand(-0.3, 0.3)),
      Vector3.create(rand(-0.6, 0.6), rand(-0.2, 0.6), rand(-0.6, 0.6)),
      rand(0.35, 0.55),
      size * rand(0.8, 1.2)
    )
  }
}

export function parryBurst(at: Vector3) {
  for (let i = 0; i < 24; i++) {
    const angle = (i / 24) * Math.PI * 2
    const speed = rand(7, 9)
    spawn(
      'parry',
      Vector3.create(at.x, at.y - 0.1, at.z),
      Vector3.create(Math.cos(angle) * speed, rand(-0.2, 0.4), Math.sin(angle) * speed),
      rand(0.3, 0.42),
      rand(0.14, 0.22),
      0,
      5 // strong drag: the ring expands fast, then stops
    )
  }
  for (let i = 0; i < 12; i++) {
    const angle = rand(0, Math.PI * 2)
    spawn(
      'parry',
      Vector3.create(at.x, at.y, at.z),
      Vector3.create(Math.cos(angle) * rand(0.5, 2), rand(4, 7), Math.sin(angle) * rand(0.5, 2)),
      rand(0.3, 0.5),
      rand(0.1, 0.16),
      7
    )
  }
}


// ---- Special attacks: a purple bubble for a projectile's own trail, a green one for decoys, and a floor blast ----

/** One trail bubble at a spot (each projectile spaces its own, so several can fly at once). */
export function trailBubble(at: Vector3) {
  spawn(
    'trail',
    Vector3.create(at.x + rand(-0.18, 0.18), at.y + rand(-0.18, 0.18), at.z + rand(-0.18, 0.18)),
    Vector3.create(rand(-0.3, 0.3), rand(0.2, 0.7), rand(-0.3, 0.3)),
    rand(0.45, 0.8),
    rand(0.14, 0.26)
  )
}

/** Green sparks behind a decoy orb. */
export function decoyTrail(at: Vector3) {
  for (let i = 0; i < 2; i++) {
    spawn(
      'lava',
      Vector3.create(at.x + rand(-0.2, 0.2), at.y + rand(-0.2, 0.2), at.z + rand(-0.2, 0.2)),
      Vector3.create(rand(-0.4, 0.4), rand(0.2, 0.9), rand(-0.4, 0.4)),
      rand(0.35, 0.6),
      rand(0.12, 0.22)
    )
  }
}

/** A floor blast: a ring of red and orange blobs races out to `radius`, with embers thrown up. */
export function blastFx(at: Vector3, radius: number) {
  const ring = 36
  for (let i = 0; i < ring; i++) {
    const a = (i / ring) * Math.PI * 2
    const speed = (radius * rand(0.85, 1.05)) / 0.3 // reaches the edge in about 0.3 s
    spawn(
      i % 2 === 0 ? 'splash' : 'parry',
      Vector3.create(at.x, at.y + 0.2, at.z),
      Vector3.create(Math.cos(a) * speed, rand(0, 0.8), Math.sin(a) * speed),
      rand(0.3, 0.45),
      rand(0.22, 0.34),
      0,
      2.5
    )
  }
  for (let i = 0; i < 26; i++) {
    const a = rand(0, Math.PI * 2)
    const r = rand(0, radius * 0.8)
    spawn(
      i % 3 === 0 ? 'lava' : 'splash',
      Vector3.create(at.x + Math.cos(a) * r, at.y + 0.2, at.z + Math.sin(a) * r),
      Vector3.create(Math.cos(a) * rand(0, 1.5), rand(4, 8), Math.sin(a) * rand(0, 1.5)),
      rand(0.6, 1.1),
      rand(0.18, 0.4),
      10
    )
  }
}

// ---- Charging energy: motes appear around a point and stream into it (the Vampire powering up the pumpkin) ----

let chargeCarry = 0

/** Call every frame while charging. `power` 0..1 raises the rate; motes shrink away as they reach the centre. */
export function chargeFx(center: Vector3, dt: number, power: number) {
  chargeCarry += dt * (40 + 90 * power)
  while (chargeCarry >= 1) {
    chargeCarry -= 1
    // a random direction on a sphere
    const y = rand(-1, 1)
    const a = rand(0, Math.PI * 2)
    const flat = Math.sqrt(1 - y * y)
    const dir = Vector3.create(Math.cos(a) * flat, y, Math.sin(a) * flat)
    const r = rand(1.6, 2.8)
    const life = rand(0.35, 0.55)
    spawn(
      Math.random() < 0.55 ? 'trail' : 'parry', // purple and orange energy
      Vector3.create(center.x + dir.x * r, center.y + dir.y * r, center.z + dir.z * r),
      Vector3.create((-dir.x * r) / life, (-dir.y * r) / life, (-dir.z * r) / life), // arrives at the centre as it ends
      life,
      rand(0.1, 0.2) * (0.8 + 0.5 * power)
    )
  }
}

// ---- Spawn: a boss (or a solo player) appears. Teleport beam + rings, a purple shockwave, rising green sparks, red embers ----

export function spawnFx(at: Vector3, big = true) {
  teleportFx(at)
  const count = big ? 30 : 16
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2
    const speed = rand(5, 8)
    spawn(
      'trail',
      Vector3.create(at.x, at.y + 0.15, at.z),
      Vector3.create(Math.cos(angle) * speed, rand(0, 0.6), Math.sin(angle) * speed),
      rand(0.5, 0.8),
      rand(0.16, 0.26),
      0,
      4 // drag: the ring races out and stops
    )
  }
  for (let i = 0; i < count; i++) {
    const angle = rand(0, Math.PI * 2)
    const r = rand(0.2, big ? 1.2 : 0.6)
    spawn(
      i % 3 === 0 ? 'splash' : 'lava', // green sparks with a few red embers
      Vector3.create(at.x + Math.cos(angle) * r, at.y + 0.1, at.z + Math.sin(angle) * r),
      Vector3.create(Math.cos(angle) * rand(0.2, 0.8), rand(2.5, big ? 6.5 : 4), Math.sin(angle) * rand(0.2, 0.8)),
      rand(0.7, 1.3),
      rand(0.1, 0.22),
      -0.8 // slight lift, like rising embers
    )
  }
}

// ---- Lava: glowing green bubbles that rise from the lava surface and pop ----

const LAVA_SPAWNS_PER_SECOND = 18

/** Spawns bubbles at random points on the real lava surface (from the model's outline). */
export function setupLavaBubbles() {
  let carry = 0
  engine.addSystem((dt: number) => {
    carry += dt * LAVA_SPAWNS_PER_SECOND
    while (carry >= 1) {
      carry -= 1
      // The lava runs under the ring's edge, where bubbles would be hidden inside the ring: skip that strip.
      let { x, z } = randomLavaPoint()
      for (let tries = 0; tries < 4 && Math.hypot(x - ARENA_CENTER.x, z - ARENA_CENTER.z) < ARENA_RADIUS + 0.8; tries++) {
        ;({ x, z } = randomLavaPoint())
      }
      const at = Vector3.create(x, LAVA_SURFACE_Y + 0.1, z)
      if (Math.random() < 0.7) {
        // Big slow bubble: swells up, drifts a little, then pops (shrinks away)
        spawn('lava', at, Vector3.create(rand(-0.15, 0.15), rand(0.5, 1.1), rand(-0.15, 0.15)), rand(1.8, 2.9), rand(0.8, 1.5))
      } else {
        // Small fast spark rising off the surface
        spawn('lava', at, Vector3.create(rand(-0.4, 0.4), rand(1.4, 2.4), rand(-0.4, 0.4)), rand(1.0, 1.7), rand(0.2, 0.4))
      }
    }
  })
}

// ---- Lava surface: glowing balls that wander around chaotically, and now and then sink out of sight and resurface elsewhere ----

const FLOW_BLOBS = 34
const FLOW_SPEED = { min: 0.4, max: 1.6 } // metres per second (varies constantly per ball)
const FLOW_GLOW = 0.9
const FLOW_ROUNDNESS = 0.75 // height / width: 1 = a perfect ball, 0.3 = a flat dome
const SINK_EVERY = { min: 6, max: 18 } // seconds between a ball sinking out of sight
const SINK_SPEED = 1.6 // presence lost per second while sinking (about 0.6 s)
const RISE_SPEED = 1.0 // presence gained per second while resurfacing (about 1 s)
const FLOW_CENTER_RADIUS = 27.5 // middle of the moat: where a ball turns back toward when it hits an edge

interface Blob {
  entity: Entity
  x: number
  z: number
  size: number
  heading: number // direction of travel, radians
  spin: number // how fast the heading is turning (random-walks, so paths curve and wobble)
  speed: number
  phase: number
  presence: number // 0..1: scales the ball and sinks it below the surface as it goes to 0
  state: 'alive' | 'sinking' | 'rising'
  sinkIn: number // seconds until it next sinks
  blocked: number // seconds spent pressed against an edge
}

function validLavaPoint(): { x: number; z: number } {
  let p = randomLavaPoint()
  for (let tries = 0; tries < 8 && Math.hypot(p.x - ARENA_CENTER.x, p.z - ARENA_CENTER.z) < ARENA_RADIUS + 1.5; tries++) {
    p = randomLavaPoint()
  }
  return p
}

const onMoat = (x: number, z: number) => isOnLava(x, z) && Math.hypot(x - ARENA_CENTER.x, z - ARENA_CENTER.z) >= ARENA_RADIUS + 0.8

export function setupLavaFlow() {
  const blobs: Blob[] = []
  for (let i = 0; i < FLOW_BLOBS; i++) {
    const entity = engine.addEntity()
    const color = PALETTE.lava[i % PALETTE.lava.length]
    const p = validLavaPoint()
    Transform.create(entity, { position: Vector3.create(p.x, LAVA_SURFACE_Y, p.z), scale: Vector3.Zero() })
    MeshRenderer.setSphere(entity)
    Material.setPbrMaterial(entity, { albedoColor: Color4.create(0.02, 0.2, 0.01, 1), emissiveColor: color, emissiveIntensity: FLOW_GLOW })
    blobs.push({
      entity,
      x: p.x,
      z: p.z,
      size: rand(1.0, 2.6),
      heading: rand(0, Math.PI * 2),
      spin: rand(-0.8, 0.8),
      speed: rand(FLOW_SPEED.min, FLOW_SPEED.max),
      phase: rand(0, Math.PI * 2),
      presence: 0, // start hidden and surface one by one
      state: 'rising',
      sinkIn: rand(SINK_EVERY.min, SINK_EVERY.max),
      blocked: 0
    })
  }

  let time = 0
  engine.addSystem((dt: number) => {
    time += dt
    for (const b of blobs) {
      // ---- chaotic wander: the turn rate random-walks, speed surges and lulls, and sudden turns happen ----
      b.spin = Math.max(-1.8, Math.min(1.8, b.spin + (Math.random() - 0.5) * 7 * dt)) * (1 - 0.4 * dt)
      b.heading += b.spin * dt
      if (Math.random() < 0.35 * dt) b.heading += rand(-1.5, 1.5) // now and then it veers off
      if (Math.random() < 0.5 * dt) b.speed = rand(FLOW_SPEED.min, FLOW_SPEED.max) // ...or speeds up / slows down
      const step = b.speed * (0.55 + 0.45 * Math.sin(time * 0.9 + b.phase)) * dt

      if (b.state !== 'sinking') {
        const nx = b.x + Math.cos(b.heading) * step
        const nz = b.z + Math.sin(b.heading) * step
        if (onMoat(nx, nz)) {
          b.x = nx
          b.z = nz
          b.blocked = 0
        } else {
          // Hit the edge of the lava (or the ring): turn back toward the middle of the moat
          const dx = b.x - ARENA_CENTER.x
          const dz = b.z - ARENA_CENTER.z
          const r = Math.hypot(dx, dz) || 1
          const mx = ARENA_CENTER.x + (dx / r) * FLOW_CENTER_RADIUS
          const mz = ARENA_CENTER.z + (dz / r) * FLOW_CENTER_RADIUS
          b.heading = Math.atan2(mz - b.z, mx - b.x) + rand(-0.7, 0.7)
          b.spin = 0
          b.blocked += dt
          if (b.blocked > 1.5 && b.state === 'alive') b.state = 'sinking' // stuck in a corner: sink and resurface elsewhere
        }
      }

      // ---- now and then: sink out of sight, come back up somewhere else ----
      if (b.state === 'alive') {
        b.sinkIn -= dt
        if (b.sinkIn <= 0) b.state = 'sinking'
        b.presence = 1
      } else if (b.state === 'sinking') {
        b.presence -= dt * SINK_SPEED
        if (b.presence <= 0) {
          const p = validLavaPoint()
          b.x = p.x
          b.z = p.z
          b.heading = rand(0, Math.PI * 2)
          b.presence = 0
          b.blocked = 0
          b.state = 'rising'
        }
      } else {
        b.presence += dt * RISE_SPEED
        if (b.presence >= 1) {
          b.presence = 1
          b.state = 'alive'
          b.sinkIn = rand(SINK_EVERY.min, SINK_EVERY.max)
        }
      }

      const breathe = 0.85 + 0.15 * Math.sin(time * 1.2 + b.phase) // slow swell so they feel alive
      const s = b.size * b.presence * breathe
      const bob = Math.sin(time * 1.6 + b.phase) * 0.06
      // As presence drops the ball also goes DOWN into the lava, so it visibly submerges instead of just shrinking
      const sunk = (1 - b.presence) * b.size * 0.7
      const tr = Transform.getMutable(b.entity)
      tr.position = Vector3.create(b.x, LAVA_SURFACE_Y + s * FLOW_ROUNDNESS * 0.18 + bob - sunk, b.z)
      tr.scale = Vector3.create(s, s * FLOW_ROUNDNESS, s)
    }
  })
}
