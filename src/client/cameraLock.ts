import { CameraModeArea, CameraType, engine, Entity, Transform } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { ARENA_CENTER } from '../shared/config'
import { inCombat } from './controls'
import { isMobile } from './platform'

/**
 * On phones, keeps the camera in third person while a game is on (a match or a solo run), so nobody can switch to first person
 * and lose sight of the arena. A CameraModeArea over the whole arena forces third person for the player inside it; it exists
 * only on this client and only while playing, and when it goes the player's own camera choice comes back.
 * Set LOCK_THIRD_PERSON_ON_DESKTOP to also do it on desktop.
 */
const LOCK_THIRD_PERSON_ON_DESKTOP = false

// Covers the ring, the lava around it and plenty of height (a fall or a jump must never leave the volume)
const AREA_SIZE = Vector3.create(70, 50, 70)

export function setupCameraLock() {
  let area: Entity | undefined
  engine.addSystem(() => {
    const want = (isMobile() || LOCK_THIRD_PERSON_ON_DESKTOP) && inCombat()
    if (want) {
      if (!area) {
        area = engine.addEntity()
        Transform.create(area, { position: Vector3.create(ARENA_CENTER.x, ARENA_CENTER.y + 10, ARENA_CENTER.z) })
      }
      if (!CameraModeArea.has(area)) CameraModeArea.create(area, { area: AREA_SIZE, mode: CameraType.CT_THIRD_PERSON })
    } else if (area && CameraModeArea.has(area)) {
      CameraModeArea.deleteFrom(area)
    }
  })
}
