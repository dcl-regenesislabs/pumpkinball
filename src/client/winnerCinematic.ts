import { engine, InputModifier, MainCamera, Transform, VirtualCamera } from '@dcl/sdk/ecs'
import { Quaternion, Vector3 } from '@dcl/sdk/math'
import { getPlayer } from '@dcl/sdk/src/players'
import { triggerEmote } from '~system/RestrictedActions'
import { findAvatar } from './avatars'
import { EVIL_LAUGH_SFX, msSincePlayed, playSfx, WIN_SFX } from './sfx'
import { ARENA_CENTER, Phase, WINNER_CAMERA, WINNER_DANCE_EMOTE, WINNER_SECONDS } from '../shared/config'
import { GameState } from '../shared/schemas'
import { solo } from './soloState'

/**
 * When a match has a winner: the winner dances, and every player's camera swings to them and orbits around
 * them until the winner phase ends. Nothing is sent over the network: each client reads the synced GameState.
 *
 * Why it used to be flaky:
 *  - the camera waited for `getPlayer(...).entity`, which can be missing for a moment (or entirely) for another
 *    player, so some clients never got a camera. The winner's avatar is now also found through PlayerIdentityData.
 *  - the dance was fired once, instantly, while the winner was still moving or finishing a swing emote, and any
 *    movement cancels an emote. The winner is now frozen for the winner phase, the dance starts after a short
 *    beat, and it is re-sent if the winner somehow moved.
 */

const MAX_AVATAR_DRIFT = 6 // meters between the found avatar and the server's reading before we distrust the avatar
const WIN_DELAY_OTHERS_S = 2.5 // others wait at least this long into the winner phase...
const LAUGH_MS = 2300 // ...and until the death laugh (1.9 s) is over
const DANCE_DELAY_S = 0.5 // let the last swing / fall settle before dancing

export function setupWinnerCinematic() {
  // The virtual camera (moved around the winner every frame) and the point it keeps looking at.
  const camera = engine.addEntity()
  Transform.create(camera, { position: Vector3.Zero() })

  let active = false
  let danced = false
  let dir = Vector3.create(0, 0, 1)
  let frozen = false
  let winPlayed = false
  let elapsed = 0
  let danceAt: Vector3 | undefined

  /**
   * Puts the camera `dist` meters from the winner on the arena side, and turns it to face them. The aim is computed
   * here from the same position, every frame. (It used to rely on the renderer's lookAtEntity, which could end up
   * pointing at the wrong thing; a plain rotation set together with the position can't disagree with it.)
   */
  const aimCamera = (pos: Vector3, dist: number) => {
    const eye = Vector3.create(pos.x + dir.x * dist, pos.y + WINNER_CAMERA.height, pos.z + dir.z * dist)
    const target = Vector3.create(pos.x, pos.y + WINNER_CAMERA.lookAtHeight, pos.z)
    const t = Transform.getMutable(camera)
    t.position = eye
    t.rotation = Quaternion.lookRotation(Vector3.subtract(target, eye))
  }

  const stop = () => {
    if (!active) return
    // Hand the camera back to the player
    MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: undefined })
    VirtualCamera.deleteFrom(camera)
    active = false
  }

  // The winner must not be able to move: any movement cancels the dance emote.
  const unfreeze = () => {
    if (!frozen) return
    InputModifier.deleteFrom(engine.PlayerEntity)
    frozen = false
  }

  engine.addSystem((dt: number) => {
    if (solo.active) {
      // Someone else's match ended while this player is in their own run: no camera takeover
      stop()
      unfreeze()
      return
    }
    let phase = ''
    let winnerId = ''
    let serverPos: Vector3 | undefined
    for (const [, s] of engine.getEntitiesWith(GameState)) {
      phase = s.phase
      winnerId = s.winnerId
      if (s.winnerX !== 0 || s.winnerY !== 0 || s.winnerZ !== 0) serverPos = Vector3.create(s.winnerX, s.winnerY, s.winnerZ)
    }

    if (phase !== Phase.Winner || winnerId === '') {
      stop()
      unfreeze()
      danced = false
      danceAt = undefined
      winPlayed = false
      elapsed = 0
      return
    }

    const me = getPlayer()?.userId?.toLowerCase()
    // Where the winner is: their avatar if we can find it, but the server's reading of where they stood is the
    // reference. If the avatar we found is nowhere near that spot it is the wrong one (or stale), so use the server's.
    const winnerEntity = findAvatar(winnerId, me)
    const live = winnerEntity !== undefined ? Transform.getOrNull(winnerEntity)?.position : undefined
    const pos = live && (!serverPos || Vector3.distance(live, serverPos) < MAX_AVATAR_DRIFT) ? live : serverPos
    if (!pos) return

    elapsed += dt

    // Win jingle: right away for the winner. Everyone else hears it only after a short wait and once their own
    // death laugh has finished, so the last player out still gets to listen to their elimination.
    if (!winPlayed && (winnerId === me ? true : elapsed >= WIN_DELAY_OTHERS_S && msSincePlayed(EVIL_LAUGH_SFX) > LAUGH_MS)) {
      winPlayed = true
      playSfx(WIN_SFX, 0.4)
    }

    if (!active) {
      // Park the camera on the winner first (position AND aim), so it never swings in from the world origin
      aimCamera(pos, WINNER_CAMERA.startDistance)
      VirtualCamera.createOrReplace(camera, {
        defaultTransition: { transitionMode: VirtualCamera.Transition.Time(0.8) },
        fov: 60 // no lookAtEntity: we aim the camera ourselves every frame, see aimCamera
      })
      MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: camera })
      active = true
      elapsed = 0
    }

    // Only the winner's own client plays the dance; emotes sync to everyone else by themselves.
    if (winnerId === me) {
      // checked every frame: the lobby controls also touch InputModifier when the round ends, and must not undo the freeze
      if (!frozen || !InputModifier.has(engine.PlayerEntity)) {
        InputModifier.createOrReplace(engine.PlayerEntity, { mode: InputModifier.Mode.Standard({ disableAll: true }) })
        frozen = true
      }
      const moved = danceAt !== undefined && Vector3.distance(danceAt, Vector3.create(pos.x, pos.y, pos.z)) > 0.4
      if (elapsed >= DANCE_DELAY_S && (!danced || moved)) {
        danced = true
        danceAt = Vector3.create(pos.x, pos.y, pos.z)
        void triggerEmote({ predefinedEmote: WINNER_DANCE_EMOTE }).catch((e) => console.log('[CLIENT] dance failed', e))
      }
    }

    // Keep the winner framed: a fixed spot on the arena side of them that slowly moves closer.
    const toCenter = Vector3.create(ARENA_CENTER.x - pos.x, 0, ARENA_CENTER.z - pos.z)
    const len = Math.hypot(toCenter.x, toCenter.z)
    if (len > 1) dir = Vector3.create(toCenter.x / len, 0, toCenter.z / len) // winner near the middle: keep the last direction
    const t = Math.min(1, elapsed / WINNER_SECONDS)
    const ease = t * t * (3 - 2 * t)
    const dist = WINNER_CAMERA.startDistance + (WINNER_CAMERA.endDistance - WINNER_CAMERA.startDistance) * ease
    aimCamera(pos, dist)

    // Make sure this client is actually looking through the winner camera (cheap check, every frame)
    if (MainCamera.getOrNull(engine.CameraEntity)?.virtualCameraEntity !== camera) {
      MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: camera })
    }
  })
}
