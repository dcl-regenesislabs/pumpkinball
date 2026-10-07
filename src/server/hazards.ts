import { engine, Entity } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { syncEntity } from '@dcl/sdk/network'
import {
  at,
  floorLifeS,
  FLOOR_HIT_MAX_HEIGHT,
  HazardEntry,
  ORB_HIT_RADIUS,
  ORB_START_OFFSET,
  orbLifeS,
  orbPosition,
  PACING,
  RING_ARM_S,
  RING_BODY_RADIUS,
  RING_END_RADIUS,
  RING_GAPS,
  RING_HIT_COOLDOWN_S,
  RING_START_RADIUS,
  RING_THICKNESS,
  ringProgress,
  ringRadius,
  ringSegmentAt,
  ringSegmentOpen
} from '../shared/arenaHazards'
import { ARENA_CENTER, ARENA_FLOOR_Y, ARENA_RADIUS } from '../shared/config'
import { ArenaHazards } from '../shared/schemas'

interface HazardDeps {
  getAlive: () => string[]
  /** An alive player was caught by a hazard (costs a heart; the server applies its own grace between hits). */
  hit: (address: string) => void
}

type Live = HazardEntry & { blasted: boolean }

const TAU = Math.PI * 2
const PRUNE_EVERY_MS = 3000
const rand = (a: number, b: number) => a + Math.random() * (b - a)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * The Vampire in a multiplayer round: rises at PACING.vampireAtS, then casts floor attacks (circles, green orbs, explosive
 * pumpkins) and, from PACING.ringsFromS, sends fire rings that close in. Pressure rises with the round (and faster when few
 * players are left) until someone is the last one standing. He is only a hazard: no health, no pumpkins to parry.
 */
export function createArenaHazards(deps: HazardDeps) {
  const entity: Entity = engine.addEntity()
  ArenaHazards.create(entity, { active: false, vampireAt: 0, entries: [] })
  syncEntity(entity, [ArenaHazards.componentId], 5)

  let running = false
  let entries: Live[] = []
  let dirty = false
  let nextId = 1
  let nextCast = 1
  let elapsed = 0 // real seconds since the round began
  let pressureClock = 0 // runs faster with fewer players alive
  let vampireUp = false
  let vampireAt = 0
  let nextFloorAt = 0
  let nextRingAt = 0
  let nextPruneAt = 0
  let publishedCount = 0 // entries in the last published list
  let lastRingGap = Math.random() * TAU
  let lastRingSpin = Math.random() < 0.5 ? -1 : 1
  const lastRingHit = new Map<string, number>()

  const crowdRate = (alive: number) => PACING.crowdRate.find((c) => alive <= c.aliveAtMost)?.rate ?? 1
  const pressure = () => clamp((pressureClock - PACING.rampFromS) / PACING.rampSeconds, 0, 1)
  /** Extra of everything once the ramp is over, so a round that is still going keeps getting harder. */
  const overtime = () => Math.max(0, Math.floor((pressureClock - PACING.rampFromS - PACING.rampSeconds) / PACING.overtimeStepS))

  function publish() {
    dirty = false
    const c = ArenaHazards.getMutable(entity)
    c.active = running
    c.vampireAt = vampireAt
    publishedCount = entries.length
    c.entries = entries.map(({ blasted, ...e }) => {
      void blasted
      return e
    })
  }

  function push(cast: number, kind: string, t0: number, f: Partial<HazardEntry>) {
    entries.push({ id: nextId++, kind, cast, t0: Math.round(t0), x: 0, z: 0, a: 0, b: 0, c: 0, d: 0, e: 0, ...f, blasted: false })
    dirty = true
  }

  function start() {
    entries = []
    nextId = 1
    nextCast = 1
    elapsed = 0
    pressureClock = 0
    vampireUp = false
    vampireAt = 0
    nextFloorAt = 0
    nextRingAt = 0
    nextPruneAt = 0
    lastRingHit.clear()
    running = true
    publish()
  }

  function stop() {
    running = false
    entries = []
    vampireUp = false
    vampireAt = 0
    publish()
  }

  /** Where players are standing, as targets: only alive players on the arena floor. */
  function targets(alive: string[], positions: Map<string, Vector3>): Vector3[] {
    const out: Vector3[] = []
    for (const a of alive) {
      const p = positions.get(a)
      if (p && Math.hypot(p.x - ARENA_CENTER.x, p.z - ARENA_CENTER.z) <= ARENA_RADIUS && p.y <= ARENA_FLOOR_Y + FLOOR_HIT_MAX_HEIGHT) out.push(p)
    }
    return out
  }

  const onArena = (x: number, z: number, margin: number) => {
    const dx = x - ARENA_CENTER.x
    const dz = z - ARENA_CENTER.z
    const d = Math.hypot(dx, dz)
    const max = ARENA_RADIUS - margin
    return d <= max ? { x, z } : { x: ARENA_CENTER.x + (dx / d) * max, z: ARENA_CENTER.z + (dz / d) * max }
  }

  // ---- Floor casts ----

  function castFloor(now: number, p: number, alive: string[], positions: Map<string, Vector3>) {
    const near = targets(alive, positions)
    const bonus = overtime()
    const weights: [string, number][] = [['tile', 1]]
    if (p >= PACING.orbsFromP) weights.push(['orb', 0.5 + 0.5 * p])
    if (p >= PACING.meteorsFromP) weights.push(['meteor', 0.4 + 0.5 * p])
    let pick = Math.random() * weights.reduce((s, w) => s + w[1], 0)
    let kind = weights[0][0]
    for (const [k, w] of weights) {
      if (pick < w) {
        kind = k
        break
      }
      pick -= w
    }
    const cast = nextCast++
    const release = now + PACING.castS * 1000

    if (kind === 'tile') {
      const t = PACING.tiles
      const count = clamp(Math.round(at(t.count, p)) + Math.floor(alive.length / PACING.extraPerAlive) + bonus, 1, 14)
      const radius = t.radius
      const centers: { x: number; z: number }[] = []
      const aimed = Math.min(near.length, 1 + Math.floor(p * (t.aimedMax - 1)))
      const shuffled = near.slice().sort(() => Math.random() - 0.5)
      for (let i = 0; i < aimed && centers.length < count; i++) centers.push({ x: shuffled[i].x, z: shuffled[i].z })
      let guard = 0
      while (centers.length < count && guard++ < 80) {
        const a = rand(0, TAU)
        const r = Math.sqrt(Math.random()) * (ARENA_RADIUS - radius - 1)
        const c = { x: ARENA_CENTER.x + Math.cos(a) * r, z: ARENA_CENTER.z + Math.sin(a) * r }
        if (centers.every((o) => Math.hypot(o.x - c.x, o.z - c.z) >= radius * 1.7)) centers.push(c)
      }
      centers.forEach((c, i) => push(cast, 'tile', release + i * t.stagger * 1000, { x: c.x, z: c.z, a: radius, b: at(t.telegraph, p) }))
    } else if (kind === 'orb') {
      const o = PACING.orbs
      const count = clamp(Math.round(at(o.count, p)) + bonus, 1, 9)
      const speed = at(o.speed, p)
      const stagger = at(o.stagger, p)
      for (let i = 0; i < count; i++) {
        let angle = rand(0, TAU)
        if (near.length > 0 && Math.random() < o.aimedChance) {
          const t = near[Math.floor(Math.random() * near.length)]
          angle = Math.atan2(t.z - ARENA_CENTER.z, t.x - ARENA_CENTER.x) + rand(-0.12, 0.12)
        }
        const dx = Math.cos(angle)
        const dz = Math.sin(angle)
        push(cast, 'orb', release + i * stagger * 1000, {
          x: ARENA_CENTER.x + dx * ORB_START_OFFSET,
          z: ARENA_CENTER.z + dz * ORB_START_OFFSET,
          a: dx,
          b: dz,
          c: speed
        })
      }
    } else {
      const m = PACING.meteors
      const count = clamp(Math.round(at(m.count, p)) + Math.floor(bonus / 2), 1, 8)
      for (let i = 0; i < count; i++) {
        let c: { x: number; z: number }
        if (near.length > 0) {
          const t = near[Math.floor(Math.random() * near.length)]
          const a = rand(0, TAU)
          const r = i === 0 ? rand(0, 1.5) : rand(1, 6)
          c = onArena(t.x + Math.cos(a) * r, t.z + Math.sin(a) * r, m.radius * 0.6)
        } else {
          const a = rand(0, TAU)
          const r = Math.sqrt(Math.random()) * (ARENA_RADIUS - m.radius)
          c = { x: ARENA_CENTER.x + Math.cos(a) * r, z: ARENA_CENTER.z + Math.sin(a) * r }
        }
        push(cast, 'meteor', release + i * m.stagger * 1000, { x: c.x, z: c.z, a: m.radius, b: at(m.telegraph, p) })
      }
    }
  }

  // ---- Fire rings ----

  function spawnRing(now: number, p: number) {
    const r = PACING.rings
    const seconds = at(r.seconds, p)
    const speed = (RING_START_RADIUS - RING_END_RADIUS) / seconds
    const gapStart = at(r.gapWidth, p)
    // The new ring's openings sit a quarter turn from the last ring's, and it turns the other way: the rings form a maze with
    // corridors between them and the way through is always a walk around, never a straight line.
    lastRingGap += Math.PI / RING_GAPS + rand(-0.4, 0.4)
    lastRingSpin = -lastRingSpin
    push(0, 'ring', now, {
      a: lastRingGap,
      b: lastRingSpin * at(r.gapSpin, p) * rand(0.8, 1.2),
      c: seconds,
      d: gapStart,
      e: Math.min(1.9, gapStart * 2.2)
    })
    nextRingAt = now + (at(r.spacing, p) / speed) * 1000
  }

  // ---- Hits and expiry ----

  function blast(e: Live, alive: string[], positions: Map<string, Vector3>) {
    for (const a of alive) {
      const p = positions.get(a)
      if (!p || p.y > ARENA_FLOOR_Y + FLOOR_HIT_MAX_HEIGHT) continue
      if (Math.hypot(p.x - e.x, p.z - e.z) <= e.a) deps.hit(a)
    }
  }

  function step(now: number, alive: string[], positions: Map<string, Vector3>) {
    const kept: Live[] = []
    const spent = new Set<number>()
    for (const e of entries) {
      const age = (now - e.t0) / 1000
      let keep = true
      if (e.kind === 'tile' || e.kind === 'meteor') {
        if (!e.blasted && age >= e.b) {
          e.blasted = true
          blast(e, alive, positions)
        }
        keep = age < floorLifeS(e)
      } else if (e.kind === 'orb') {
        if (age >= 0) {
          const o = orbPosition(e, age)
          keep = age < orbLifeS(e)
          for (const a of alive) {
            const p = positions.get(a)
            if (!p) continue
            if (Math.hypot(p.x - o.x, p.z - o.z) <= ORB_HIT_RADIUS && Math.abs(p.y + 1 - o.y) <= ORB_HIT_RADIUS) {
              deps.hit(a)
              keep = false // an orb is spent on the first player it reaches
              spent.add(e.id)
              break
            }
          }
        }
      } else if (e.kind === 'ring') {
        const u = ringProgress(e, age)
        keep = u < 1
        if (keep && age >= RING_ARM_S) ringHits(e, age, now, alive, positions)
      }
      if (keep) kept.push(e)
      else if (spent.has(e.id)) dirty = true // a hit orb must vanish for everyone at once
    }
    entries = kept
    // Clients let go of finished entries on their own, so the list is only re-sent now and then to drop them
    if (now >= nextPruneAt) {
      nextPruneAt = now + PRUNE_EVERY_MS
      if (entries.length !== publishedCount) dirty = true
    }
  }

  function ringHits(e: Live, age: number, now: number, alive: string[], positions: Map<string, Vector3>) {
    const r = ringRadius(ringProgress(e, age))
    for (const a of alive) {
      const p = positions.get(a)
      if (!p || p.y > ARENA_FLOOR_Y + FLOOR_HIT_MAX_HEIGHT) continue
      const dx = p.x - ARENA_CENTER.x
      const dz = p.z - ARENA_CENTER.z
      if (Math.abs(Math.hypot(dx, dz) - r) > RING_THICKNESS / 2 + RING_BODY_RADIUS) continue
      if (ringSegmentOpen(e, age, ringSegmentAt(Math.atan2(dz, dx)))) continue
      if (now - (lastRingHit.get(a) ?? 0) < RING_HIT_COOLDOWN_S * 1000) continue
      lastRingHit.set(a, now)
      deps.hit(a)
    }
  }

  // ---- Per tick ----

  function update(dt: number, positions: Map<string, Vector3>) {
    if (!running) return
    const now = Date.now()
    const alive = deps.getAlive()
    elapsed += dt
    pressureClock += dt * crowdRate(alive.length)
    const p = pressure()

    if (!vampireUp && elapsed >= PACING.vampireAtS) {
      vampireUp = true
      vampireAt = now
      nextFloorAt = now + PACING.firstCastDelayS * 1000
      dirty = true
      console.log('[SERVER] the Vampire rises')
    }
    if (vampireUp && now >= nextFloorAt) {
      castFloor(now, p, alive, positions)
      nextFloorAt = now + at(PACING.castEvery, p) * 1000
    }
    if (elapsed >= PACING.ringsFromS && now >= nextRingAt) spawnRing(now, p)

    step(now, alive, positions)
    if (dirty) publish()
  }

  return { start, stop, update }
}
