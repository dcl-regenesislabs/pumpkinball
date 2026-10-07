import { AvatarAnchorPointType, AvatarAttach, engine, Entity, GltfContainer, InputAction, inputSystem, PointerEventType, Transform } from '@dcl/sdk/ecs'
import { Quaternion, Vector3 } from '@dcl/sdk/math'
import { getPlayer } from '@dcl/sdk/src/players'
import { RING_CALIBRATION, TARGET_RING_MODEL, TARGET_RING_RADIUS, TARGET_RING_SPIN_DEG_PER_S, TARGET_RING_UNITY_OFFSET_Y } from '../shared/config'
import { PlayerState, Pumpkin } from '../shared/schemas'
import { soloPumpkinTargetsMe } from './solo'
import { solo } from './soloState'
import { parryFeedback } from './feedback'
import { isBevy, isMobile } from './platform'

const RING_LIFT = 0.12 // meters above the attach point

/**
 * The ring on the ground around whichever player the pumpkin is hunting.
 *
 * Like the bat (weapon.ts), every player gets their own ring, attached to their avatar ONCE and never re-pointed, so it
 * moves with the player exactly (no following, no lag). Showing it for the hunted player and hiding it for the others is a
 * scale change on a child. The ring is the TargetRing.glb model (TARGET_RING_MODEL in config.ts): it pulses and spins.
 *
 * Height: the desktop (Unity) client places the attach point lower than Bevy does, which buried the ring under the floor.
 * The ring is lifted by a fixed amount outside Bevy: TARGET_RING_UNITY_OFFSET_Y in config.ts (found by hand).
 * RING_CALIBRATION = true brings back the live tuning (keys 1 and 2).
 */
interface Ring {
  root: Entity
  ring: Entity
  spinner: Entity
  spin: number
  shown: boolean
}
const rings = new Map<string, Ring>()
let unityOffsetY = TARGET_RING_UNITY_OFFSET_Y

const ringY = () => RING_LIFT + (isBevy() ? 0 : unityOffsetY)

function createRing(playerId: string): Ring {
  const root = engine.addEntity()
  AvatarAttach.create(root, { avatarId: playerId, anchorPointId: AvatarAnchorPointType.AAPT_POSITION })
  const ring = engine.addEntity()
  Transform.create(ring, { parent: root, position: Vector3.create(0, ringY(), 0), scale: Vector3.Zero() })
  const spinner = engine.addEntity()
  Transform.create(spinner, { parent: ring, scale: Vector3.create(TARGET_RING_RADIUS, 1, TARGET_RING_RADIUS) })
  GltfContainer.create(spinner, { src: TARGET_RING_MODEL, visibleMeshesCollisionMask: 0, invisibleMeshesCollisionMask: 0 })
  return { root, ring, spinner, spin: 0, shown: false }
}

function removeRing(playerId: string) {
  const r = rings.get(playerId)
  if (!r) return
  engine.removeEntity(r.spinner)
  engine.removeEntity(r.ring)
  engine.removeEntity(r.root)
  rings.delete(playerId)
}

export function setupTargetMarker() {
  let t = 0
  engine.addSystem((dt: number) => {
    t += dt

    // Calibration (desktop, off by default): key 1 raises the ring by 10 cm, key 2 lowers it. The value is shown on screen.
    if (RING_CALIBRATION && !isMobile() && !isBevy()) {
      const up = inputSystem.isTriggered(InputAction.IA_ACTION_3, PointerEventType.PET_DOWN)
      const down = inputSystem.isTriggered(InputAction.IA_ACTION_4, PointerEventType.PET_DOWN)
      if (up || down) {
        unityOffsetY += up ? 0.1 : -0.1
        parryFeedback.notice(`Ring offset ${unityOffsetY.toFixed(1)} m`)
        console.log('[CLIENT] ring offset', unityOffsetY.toFixed(2))
        for (const r of rings.values()) Transform.getMutable(r.ring).position = Vector3.create(0, ringY(), 0)
      }
    }

    // One ring per player in the scene, attached once their avatar has loaded (same gate as the bat)
    const present = new Set<string>()
    for (const [, p] of engine.getEntitiesWith(PlayerState)) present.add(p.playerId)
    for (const id of present) {
      if (rings.has(id) || !getPlayer({ userId: id })) continue
      rings.set(id, createRing(id))
    }
    for (const id of [...rings.keys()]) if (!present.has(id)) removeRing(id)

    let targetId = ''
    for (const [, p] of engine.getEntitiesWith(Pumpkin)) targetId = p.active ? p.targetId : ''

    // In a solo run only the Vampire's pumpkin counts (another match's target would be hidden from us anyway)
    if (solo.active) targetId = soloPumpkinTargetsMe() ? (getPlayer()?.userId?.toLowerCase() ?? '') : ''

    // While calibrating, your own ring is always shown, so you can tune it without a round running
    if (RING_CALIBRATION && !isMobile() && !isBevy()) targetId = getPlayer()?.userId?.toLowerCase() ?? targetId

    const pulse = 1 + Math.sin(t * 6) * 0.07
    for (const [id, r] of rings) {
      if (id !== targetId) {
        if (r.shown) {
          Transform.getMutable(r.ring).scale = Vector3.Zero() // hide once, not every frame
          r.shown = false
        }
        continue
      }
      r.shown = true
      Transform.getMutable(r.ring).scale = Vector3.create(pulse, 1, pulse)
      r.spin = (r.spin + TARGET_RING_SPIN_DEG_PER_S * dt) % 360
      Transform.getMutable(r.spinner).rotation = Quaternion.fromEulerDegrees(0, r.spin, 0)
    }
  })
}
