import { AvatarAnchorPointType, AvatarAttach, engine, Entity, GltfContainer, Transform } from '@dcl/sdk/ecs'
import { Quaternion, Vector3 } from '@dcl/sdk/math'
import { getPlayer } from '@dcl/sdk/src/players'
import {
  SWORD_MODEL,
  SWORD_OFFSET,
  SWORD_ROLL_DEGREES,
  SWORD_ROTATION_DEGREES,
  SWORD_SCALE
} from '../shared/config'
import { PlayerState } from '../shared/schemas'
import { isHiddenFromMe } from './soloVisibility'

interface Weapon {
  root: Entity
  model: Entity
}
const weapons = new Map<string, Weapon>()

function createWeapon(playerId: string): Weapon {
  // Every client attaches a sword to every armed avatar, so everyone sees everyone's weapon.
  const root = engine.addEntity()
  AvatarAttach.create(root, { avatarId: playerId, anchorPointId: AvatarAnchorPointType.AAPT_RIGHT_HAND })

  const model = engine.addEntity()
  Transform.create(model, {
    parent: root,
    position: Vector3.create(SWORD_OFFSET.x, SWORD_OFFSET.y, SWORD_OFFSET.z),
    // Roll around the blade's own axis first, then aim the blade (multiply applies the right factor first).
    rotation: Quaternion.multiply(
      Quaternion.fromEulerDegrees(SWORD_ROTATION_DEGREES.x, SWORD_ROTATION_DEGREES.y, SWORD_ROTATION_DEGREES.z),
      Quaternion.fromEulerDegrees(0, SWORD_ROLL_DEGREES, 0)
    ),
    scale: Vector3.create(SWORD_SCALE, SWORD_SCALE, SWORD_SCALE)
  })
  GltfContainer.create(model, { src: SWORD_MODEL })
  return { root, model }
}

function removeWeapon(playerId: string) {
  const w = weapons.get(playerId)
  if (!w) return
  engine.removeEntity(w.model)
  engine.removeEntity(w.root)
  weapons.delete(playerId)
}

/** Every player in the scene holds the sword, in the lobby too (swinging it there is just for fun). */
export function setupWeapons() {
  engine.addSystem(() => {
    const armed = new Set<string>()
    for (const [, p] of engine.getEntitiesWith(PlayerState)) armed.add(p.playerId)

    for (const id of armed) {
      if (weapons.has(id)) continue
      // Attach only once this avatar's data is loaded. Attaching at the instant a player joins
      // can miss: the avatar isn't ready yet, so the sword would never show up.
      if (!getPlayer({ userId: id })) continue
      weapons.set(id, createWeapon(id))
      console.log('[CLIENT] sword attached to', id)
    }
    for (const id of [...weapons.keys()]) if (!armed.has(id)) removeWeapon(id)

    // A bat stays attached to an avatar that is hidden in the ring (someone else's solo run or match): hide it too
    for (const [id, w] of weapons) {
      const s = isHiddenFromMe(id) ? 0 : SWORD_SCALE
      const t = Transform.getMutable(w.model)
      if (t.scale.x !== s) t.scale = Vector3.create(s, s, s)
    }
  })
}
