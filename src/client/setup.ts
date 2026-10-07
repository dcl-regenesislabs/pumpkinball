import { engine, GltfContainer, InputAction, inputSystem, PointerEventType, Transform } from '@dcl/sdk/ecs'
import { getPlayer } from '@dcl/sdk/src/players'
import { Color4, Quaternion, Vector3 } from '@dcl/sdk/math'
import { movePlayerTo } from '~system/RestrictedActions'
import {
  LAVA_SURFACE_Y,
  PARRY_LATE_GRACE_S,
  PUMPKIN_AIM_HEIGHT,
  PUMPKIN_CONTACT_RADIUS,
  PUMPKIN_MODEL,
  PUMPKIN_MODEL_OFFSET_Y,
  PUMPKIN_MODEL_SCALE,
  PUMPKIN_TUMBLE_DEG_PER_S,
  PUMPKIN_BOB_HEIGHT
} from '../shared/config'
import { room } from '../shared/messages'
import { stepPumpkin } from '../shared/pumpkinSim'
import { setupCameraFace } from './cameraFace'
import { setupCameraLock } from './cameraLock'
import { inCombat, setupControls } from './controls'
import { parryFeedback } from './feedback'
import { requestParry, sinceLastPress, swing, updateParryFeedback } from './parry'
import { debug } from './debug'
import { bloodSplat, setupBlood } from './blood'
import { teleportFx, lavaSplash, parryBurst, setupEffects, setupLavaBubbles, setupLavaFlow, splash, trail, trailReset } from './effects'
import { feed } from './feed'
import { displayName } from './names'
import { isMobile, resolvePlatform } from './platform'
import { setupLeaderboardBoard } from './leaderboard'
import { setupLights } from './lights'
import { setupStartLights } from './startLights'
import { setupStartSign } from './startSign'
import { setupMusic } from './music'
import { setupDummies } from './dummy'
import { setupRoundStart } from './roundStart'
import { BAT_HIT_SFX, EVIL_LAUGH_SFX, HURT_SFX, playSfx, playSfxAt, preloadSfx, TELEPORT_SFX } from './sfx'
import { setupWinnerCinematic } from './winnerCinematic'
import { setupSpinningModels } from './spin'
import { setupWeapons } from './weapon'
import { isServerAlive, updateServerReadiness } from './serverReadiness'
import { setupTargetMarker } from './targetMarker'
import { Pumpkin } from '../shared/schemas'
import { setupSolo } from './solo'
import { solo } from './soloState'
import { setupSoloVisibility } from './soloVisibility'
import { setupVampire } from './vampire'

export function initClient() {
  preloadSfx()
  setupEffects()
  setupBlood()
  setupLavaBubbles()
  setupLavaFlow()
  setupSpinningModels()
  setupLights()
  setupStartLights()
  setupStartSign()
  setupMusic()
  setupDummies()
  setupRoundStart()
  setupLeaderboardBoard()
  setupWinnerCinematic()
  setupVampire()
  setupSolo()
  setupSoloVisibility()

  // Tell the server this player's display name (once, and again if the server restarts), so a win can be shown
  // on the leaderboard by name even after they leave.
  let wasAlive = false
  engine.addSystem(() => {
    const alive = isServerAlive()
    const name = getPlayer()?.name
    if (alive && !wasAlive && name) {
      room.send('hello', { name })
      wasAlive = true
    } else if (!alive) {
      wasAlive = false
    }
  })
  setupPumpkin()
  setupTargetMarker()
  engine.addSystem(updateServerReadiness)

  resolvePlatform()
  setupWeapons()
  setupControls()
  setupCameraLock()
  setupCameraFace()

  // E (primary action) = parry. Whether it lands is decided by the pumpkin system below (from what this
  // client sees) and validated by the server.
  engine.addSystem(updateParryFeedback)
  engine.addSystem(() => {
    if (inputSystem.isTriggered(InputAction.IA_PRIMARY, PointerEventType.PET_DOWN)) requestParry()
  })
  // Left click swings too, on desktop, once a game has started (a match or a solo run). Not in the lobby, so clicking
  // things there (the Vampire, dialogs) never swings, and not during the level intro or after a level ends.
  engine.addSystem(() => {
    if (isMobile() || !inCombat() || solo.intro || (solo.active && solo.phase !== 'fight')) return
    if (inputSystem.isTriggered(InputAction.IA_POINTER, PointerEventType.PET_DOWN)) requestParry()
  })

  room.onMessage('resolveResult', (d) => {
    debug.server = `server: seq ${d.seq} ${d.ok ? 'accepted' : 'REJECTED (' + d.reason + ')'}`
  })
  room.onMessage('feed', (d) => {
    if (solo.active) return // someone else's match: nothing of it shows in a solo run
    const kind = d.kind === 'fall' ? 'fall' : 'elim'
    feed.add({ kind, victimId: d.victimId, killerId: d.killerId, at: Date.now() })
    // A splash where they fell in (the victim has already been teleported away, so the server sends the spot)
    if (kind === 'fall') lavaSplash(Vector3.create(d.x, LAVA_SURFACE_Y + 0.15, d.z))
    bloodSplat(d.x, d.z) // a stain on the ring where they went out (kept until the next game starts)
    if (d.victimId === getPlayer()?.userId?.toLowerCase()) {
      playSfx(EVIL_LAUGH_SFX) // right as the skull appears
      parryFeedback.eliminate(
        kind === 'fall' ? 'You touched the lava' : d.killerId ? `Eliminated by ${displayName(d.killerId)}` : 'The pumpkin got you'
      )
    }
  })
  room.onMessage('parryHit', (d) => {
    if (solo.active) return
    parryFeedback.recordHit()
    if (d.playerId === getPlayer()?.userId?.toLowerCase()) return // this client already showed its own burst
    const at = targetAimPosition(d.playerId)
    if (at) {
      parryBurst(at)
      playSfxAt(BAT_HIT_SFX, at)
    }
  })
  room.onMessage('playerHit', (d) => {
    if (solo.active) return
    if (d.playerId === getPlayer()?.userId?.toLowerCase()) return // this client already showed its own splash
    const at = targetAimPosition(d.playerId)
    if (at) {
      splash(at)
      playSfxAt(HURT_SFX, at)
    }
  })
  room.onMessage('damaged', (d) => {
    if (d.hp > 0) parryFeedback.notice(`OUCH! ${d.hp} HP left`)
  })

  // The teleport effect, for everyone, where the player left and where they land
  room.onMessage('teleportFx', (d) => {
    teleportFx(Vector3.create(d.fx, d.fy, d.fz))
    teleportFx(Vector3.create(d.tx, d.ty, d.tz))
  })

  room.onMessage('teleport', (d) => {
    playSfx(TELEPORT_SFX, 0.2) // every teleport: into the arena, out of it when you lose, back to the lobby
    movePlayerTo({
      newRelativePosition: Vector3.create(d.x, d.y, d.z),
      cameraTarget: Vector3.create(d.lookX, d.lookY, d.lookZ)
    })
  })
}

/** Where the pumpkin should be aiming, as this client sees the target avatar. */
function targetAimPosition(targetId: string): Vector3 | undefined {
  const entity = targetId ? getPlayer({ userId: targetId })?.entity : undefined
  const pos = entity !== undefined ? Transform.getOrNull(entity)?.position : undefined
  return pos ? Vector3.create(pos.x, pos.y + PUMPKIN_AIM_HEIGHT, pos.z) : undefined
}

/**
 * Local visual of the pumpkin. The server publishes one update per flight (origin, target, chain
 * level); this client then runs the same movement rule as the server (shared/pumpkinSim.ts) against
 * the target avatar's *live* position on this screen. Nothing is streamed per frame, so the ball
 * follows a moving target instantly and a network stall can't freeze it.
 */
function setupPumpkin() {
  // `body` carries the ball's position, spin and hit-pulse; the model hangs off it, centered and scaled to ~1 m.
  const body = engine.addEntity()
  Transform.create(body, { scale: Vector3.Zero() })
  const model = engine.addEntity()
  Transform.create(model, {
    parent: body,
    position: Vector3.create(0, PUMPKIN_MODEL_OFFSET_Y, 0),
    scale: Vector3.create(PUMPKIN_MODEL_SCALE, PUMPKIN_MODEL_SCALE, PUMPKIN_MODEL_SCALE)
  })
  GltfContainer.create(model, { src: PUMPKIN_MODEL })
  let tumble = 0 // seconds of tumbling

  // What this client is currently simulating. Usually the server's flight; right after this player
  // parries or gets hit it continues the rally on its own (the server announced the next target in
  // advance), so the ball never sits on the player waiting for a round trip.
  let lastServerSeq = -1
  let curSeq = -1
  let curTarget = ''
  let curNext = ''
  let curLevel = 0
  let pos = Vector3.Zero()
  let hoverLeft = 0
  let flightT = 0
  let arrivedAt = 0 // ms when the ball reached its target on this screen
  let reportedSeq = -1

  const report = (kind: 'parry' | 'hit', me: string) => {
    reportedSeq = curSeq
    debug.resolve = `seq ${curSeq}: reported ${kind} | last press ${Math.round(sinceLastPress())}ms ago`
    room.send('resolve', { seq: curSeq, kind, x: pos.x, y: pos.y, z: pos.z })
    if (kind === 'parry') {
      parryFeedback.notice('PARRY!')
      parryFeedback.recordHit()
      parryBurst(pos)
      playSfx(BAT_HIT_SFX)
    } else {
      splash(pos) // instant local feedback; other players get it from the server's playerHit message
      playSfx(HURT_SFX)
    }
    // Continue the rally right away toward the announced next target, exactly as the server will.
    if (curNext && curNext !== me) {
      curSeq++
      curTarget = curNext
      curNext = ''
      curLevel++
      hoverLeft = 0
      flightT = 0
      arrivedAt = 0
    }
  }

  engine.addSystem((dt: number) => {
    let flight
    for (const [, p] of engine.getEntitiesWith(Pumpkin)) flight = p
    const t = Transform.getMutable(body)
    if (solo.active) {
      // A solo run draws its own pumpkin and trail (solo.ts); this one must not touch the shared trail
      t.scale = Vector3.Zero()
      lastServerSeq = -1
      curSeq = -1
      return
    }
    if (!flight || !flight.active) {
      t.scale = Vector3.Zero()
      lastServerSeq = -1
      curSeq = -1
      trailReset()
      return
    }

    if (flight.seq !== lastServerSeq) {
      lastServerSeq = flight.seq
      if (flight.seq === curSeq && flight.targetId === curTarget) {
        // The server confirmed the flight this client already started: keep it running, no snap.
        curNext = flight.nextTargetId
        curLevel = flight.level
      } else {
        // A flight this client didn't predict: start it from the published origin.
        curSeq = flight.seq
        curTarget = flight.targetId
        curNext = flight.nextTargetId
        curLevel = flight.level
        pos = Vector3.create(flight.ox, flight.oy, flight.oz)
        hoverLeft = flight.delayMs / 1000
        flightT = 0
        arrivedAt = 0
      }
    }

    if (hoverLeft > 0) {
      hoverLeft -= dt
    } else {
      flightT += dt
      const aim = targetAimPosition(curTarget)
      if (aim) {
        pos = stepPumpkin(pos, aim, curLevel, flightT, dt)
        trail(pos)
        if (arrivedAt === 0 && Vector3.distance(pos, aim) <= PUMPKIN_CONTACT_RADIUS) arrivedAt = Date.now()
      }
    }

    // The target's client is the referee for its own ball: what this player sees is what counts.
    // A live swing at contact (or just after) parries; otherwise it hits after a short grace.
    const me = getPlayer()?.userId?.toLowerCase()
    if (me && curTarget === me && arrivedAt > 0 && reportedSeq !== curSeq) {
      if (swing.live()) {
        swing.consume()
        report('parry', me)
      } else if (Date.now() - arrivedAt >= PARRY_LATE_GRACE_S * 1000) {
        report('hit', me)
      }
    }
    t.position = Vector3.create(pos.x, pos.y + Math.sin(tumble * 7) * PUMPKIN_BOB_HEIGHT, pos.z)

    // Pulse on a landed parry; the ground ring and the HUD already show who is being hunted.
    const size = parryFeedback.sinceHit() < 200 ? 1.4 : 1
    // Tumbles on all three axes the whole time (in flight, hovering, and sitting on its target).
    tumble += dt
    t.rotation = Quaternion.fromEulerDegrees(
      (tumble * PUMPKIN_TUMBLE_DEG_PER_S.x) % 360,
      (tumble * PUMPKIN_TUMBLE_DEG_PER_S.y) % 360,
      (tumble * PUMPKIN_TUMBLE_DEG_PER_S.z) % 360
    )
    t.scale = Vector3.create(size, size, size)
  })
}
