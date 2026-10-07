import { Vector3 } from '@dcl/sdk/math'
import { PARRY_SPEED_STEP, PUMPKIN_ACCEL, PUMPKIN_BASE_SPEED, PUMPKIN_HIT_RADIUS, PUMPKIN_MAX_SPEED } from './config'

/** Speed after `flightSeconds` in the air, for a chain that has been parried `level` times. */
export function pumpkinSpeed(level: number, flightSeconds: number): number {
  return Math.min(PUMPKIN_BASE_SPEED + level * PARRY_SPEED_STEP + PUMPKIN_ACCEL * flightSeconds, PUMPKIN_MAX_SPEED)
}

/**
 * One step of the pumpkin's movement: straight toward the target at the current speed.
 * Server (for hits and parries) and clients (for the visual) both run this, so they agree without
 * the server streaming positions. Stops once it has arrived, so it rides along with the target.
 */
export function stepPumpkin(pos: Vector3, aim: Vector3, level: number, flightSeconds: number, dt: number, speedMult = 1): Vector3 {
  const to = Vector3.subtract(aim, pos)
  const dist = Vector3.length(to)
  if (dist <= PUMPKIN_HIT_RADIUS * 0.5) return aim
  const speed = Math.min(pumpkinSpeed(level, flightSeconds) * speedMult, PUMPKIN_MAX_SPEED) // the level multiplier never beats the global cap
  const move = Math.min(speed * dt, dist)
  return Vector3.add(pos, Vector3.scale(Vector3.normalize(to), move))
}
