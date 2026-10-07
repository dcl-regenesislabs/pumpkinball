import { engine, Transform } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { movePlayerTo } from '~system/RestrictedActions'

/**
 * After a cinematic camera hands the view back, the explorer can leave the player's camera pitched straight down. This stands the
 * player on the spot they are already on and points their camera at a target, which puts it back behind the avatar the normal
 * third-person way. It waits a moment so the blend out of the cinematic camera has started first.
 */
const DELAY_S = 0.25

let pending: Vector3 | undefined
let wait = 0

/** Re-aim the player's camera at `target` (a world point) shortly from now. */
export function faceCameraAfter(target: Vector3) {
  pending = Vector3.clone(target)
  wait = DELAY_S
}

/** A point `distance` metres ahead of where the avatar faces, at chest height: looking there is a plain level view. */
export function aheadOfPlayer(distance = 10): Vector3 {
  const t = Transform.getOrNull(engine.PlayerEntity)
  if (!t) return Vector3.create(80, 6, 80)
  const f = Vector3.rotate(Vector3.Forward(), t.rotation)
  const len = Math.hypot(f.x, f.z) || 1
  return Vector3.create(t.position.x + (f.x / len) * distance, t.position.y + 1.4, t.position.z + (f.z / len) * distance)
}

export function setupCameraFace() {
  engine.addSystem((dt: number) => {
    if (!pending) return
    wait -= dt
    if (wait > 0) return
    const target = pending
    pending = undefined
    const me = Transform.getOrNull(engine.PlayerEntity)?.position
    if (!me) return
    void movePlayerTo({
      newRelativePosition: Vector3.create(me.x, me.y, me.z),
      cameraTarget: target
    }).catch(() => {})
  })
}
