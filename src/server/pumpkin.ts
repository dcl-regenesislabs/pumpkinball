import { engine, Entity } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { syncEntity } from '@dcl/sdk/network'
import {
  ARENA_CENTER,
  PUMPKIN_AIM_HEIGHT,
  PUMPKIN_HIT_RADIUS,
  PUMPKIN_LAUNCH_DELAY,
  PUMPKIN_MAX_SPEED,
  PERFECT_PARRY_SPEED_MULT,
  SERVER_FALLBACK_S,
  SERVER_PLAUSIBLE_S
} from '../shared/config'
import { pumpkinSpeed, stepPumpkin } from '../shared/pumpkinSim'
import { Pumpkin } from '../shared/schemas'

export interface PumpkinDeps {
  getAlive: () => string[]
  /** The pumpkin reached this player (costs HP; the caller decides about elimination). */
  onHit: (address: string) => void
}

const CENTER = Vector3.create(ARENA_CENTER.x, ARENA_CENTER.y + 1.5, ARENA_CENTER.z)

/**
 * The pumpkin as a series of flights. The server publishes a flight's start (origin, target, chain
 * level); clients simulate the ball themselves. The TARGET's client decides when the ball reached it
 * and whether a swing was live, then sends `resolve`. The server validates that report against its own
 * simulation (loosely, since the two views differ by latency) and starts the next flight. If no report
 * arrives, the server's simulation applies the hit after a fallback delay.
 */
export function createPumpkin(deps: PumpkinDeps) {
  const entity: Entity = engine.addEntity()
  Pumpkin.create(entity, { active: false, seq: 0, ox: 0, oy: 0, oz: 0, targetId: '', nextTargetId: '', delayMs: 0, level: 0, boost: 1 })
  syncEntity(entity, [Pumpkin.componentId], 3)

  let active = false
  let seq = 0
  let level = 0 // parries in this chain
  let boost = 1 // this flight's speed multiplier (a perfect parry sent it)
  let target = ''
  let lastParrier = '' // who last parried it: credited for eliminations that follow ('' = nobody yet)
  let nextTarget = '' // decided in advance and published, so the target's client can continue the rally instantly
  let pos = Vector3.clone(CENTER)
  let hoverLeft = 0 // seconds before the flight starts
  let flightT = 0 // seconds in flight, drives the speed ramp
  let arrivedFor = 0 // seconds the ball has been sitting on its target
  let positions = new Map<string, Vector3>()

  /** Random alive player, preferring anyone other than `exclude` (solo falls back to the same player). */
  function pickTarget(exclude?: string): string {
    const alive = deps.getAlive()
    const pool = alive.filter((a) => a !== exclude)
    const from = pool.length ? pool : alive
    return from.length ? from[Math.floor(Math.random() * from.length)] : ''
  }

  function aimAt(address: string): Vector3 | undefined {
    const p = positions.get(address)
    return p ? Vector3.create(p.x, p.y + PUMPKIN_AIM_HEIGHT, p.z) : undefined
  }

  /** Starts a new flight from `from` toward a fresh target. One component write per flight. */
  function launch(from: Vector3, exclude: string | undefined, delayS: number, forced?: string, speedMult = 1) {
    target = forced ?? pickTarget(exclude)
    if (!target) return stop()

    pos = Vector3.clone(from)
    boost = speedMult
    nextTarget = pickTarget(target)
    hoverLeft = delayS
    flightT = 0
    arrivedFor = 0
    active = true
    seq++

    const p = Pumpkin.getMutable(entity)
    p.active = true
    p.seq = seq
    p.ox = pos.x
    p.oy = pos.y
    p.oz = pos.z
    p.targetId = target
    p.nextTargetId = nextTarget
    p.delayMs = Math.round(delayS * 1000)
    p.level = level
    p.boost = boost
  }

  function stop() {
    active = false
    target = ''
    Pumpkin.getMutable(entity).active = false
  }

  /**
   * A parry or a hit both keep the rally going: from where the target stands, one level faster, to someone else.
   * `speedMult` boosts only the flight this starts (a perfect parry).
   */
  function continueRally(from: Vector3, justHandled: string, speedMult = 1) {
    level++
    const others = deps.getAlive().filter((a) => a !== justHandled)
    const planned = others.includes(nextTarget) ? nextTarget : undefined // the target clients already expect
    if (others.length) launch(from, justHandled, 0, planned, speedMult)
    else if (deps.getAlive().length) launch(CENTER, undefined, 1) // solo test: nobody else to send it to
    else stop()
  }

  return {
    start() {
      level = 0
      lastParrier = ''
      launch(CENTER, undefined, PUMPKIN_LAUNCH_DELAY)
    },

    stop,

    lastParrier: () => lastParrier,

    /**
     * The target's client says its flight ended in a parry or a hit. Accepted only for the current flight,
     * from its target, and while the server's own ball is plausibly close. `reported` is the ball position
     * (the target's chest) the next flight should start from. A `perfect` parry sends the next flight faster.
     */
    resolve(address: string, flightSeq: number, kind: string, reported: Vector3, perfect: boolean): 'ok' | 'stale' | 'implausible' {
      if (!active || flightSeq !== seq || target !== address || hoverLeft > 0) return 'stale'

      const aim = aimAt(address) ?? pos
      const speed = Math.min(pumpkinSpeed(level, flightT) * boost, PUMPKIN_MAX_SPEED) // capped like stepPumpkin
      const secondsToImpact = Math.max(0, Vector3.distance(pos, aim) - PUMPKIN_HIT_RADIUS) / speed
      if (secondsToImpact > SERVER_PLAUSIBLE_S) return 'implausible'

      // Trust the reported start point only if it is near where the server sees the player.
      const serverPos = positions.get(address)
      const from = serverPos && Vector3.distance(reported, Vector3.create(serverPos.x, serverPos.y + PUMPKIN_AIM_HEIGHT, serverPos.z)) > 8 ? aim : reported

      if (kind === 'hit') deps.onHit(address)
      else lastParrier = address
      continueRally(from, address, kind === 'parry' && perfect ? PERFECT_PARRY_SPEED_MULT : 1)
      return 'ok'
    },

    update(dt: number, latest: Map<string, Vector3>) {
      positions = latest
      if (!active) return

      if (!deps.getAlive().includes(target)) {
        // Target was eliminated or left mid-flight: continue toward someone else.
        launch(pos, undefined, 0.5)
        return
      }

      if (hoverLeft > 0) {
        hoverLeft -= dt
        return
      }

      flightT += dt
      const aim = aimAt(target)
      if (!aim) return
      pos = stepPumpkin(pos, aim, level, flightT, dt, boost)

      if (Vector3.distance(pos, aim) <= PUMPKIN_HIT_RADIUS) {
        arrivedFor += dt
        if (arrivedFor >= SERVER_FALLBACK_S) {
          // The target's client never reported (AFK, disconnected, or lying): the server applies the hit.
          const victim = target
          deps.onHit(victim)
          continueRally(Vector3.clone(pos), victim)
        }
      } else {
        arrivedFor = 0
      }
    }
  }
}
