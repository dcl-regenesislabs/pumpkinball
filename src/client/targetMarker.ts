import {
  AvatarAnchorPointType,
  AvatarAttach,
  engine,
  Entity,
  GltfContainer,
  InputAction,
  inputSystem,
  Material,
  MeshRenderer,
  PointerEventType,
  Transform
} from '@dcl/sdk/ecs'
import { Color4, Quaternion, Vector3 } from '@dcl/sdk/math'
import { getPlayer } from '@dcl/sdk/src/players'
import {
  APPROACH_RING_BEAD_SIZE,
  APPROACH_RING_BEADS,
  APPROACH_RING_RIM,
  APPROACH_RING_SECONDS,
  APPROACH_RING_START_SCALE,
  PARRY_PERFECT_LEAD_MS,
  RING_CALIBRATION,
  TARGET_RING_MODEL,
  TARGET_RING_RADIUS,
  TARGET_RING_SPIN_DEG_PER_S,
  TARGET_RING_UNITY_OFFSET_Y
} from '../shared/config'
import { PlayerState, Pumpkin } from '../shared/schemas'
import { soloPumpkinTargetsMe } from './solo'
import { solo } from './soloState'
import { parryFeedback } from './feedback'
import { incoming } from './incoming'
import { isBevy, isMobile } from './platform'

const RING_LIFT = 0.12 // meters above the attach point
const PULSE = 0.07 // the target ring breathes this much (not while your approach ring closes in: it holds still to be landed on)

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

/**
 * The approach ring: glowing beads around YOUR target ring that close in as your pumpkin comes, at a steady pace, and land on
 * its rim at the perfect moment (PARRY_PERFECT_LEAD_MS before contact): swing right then for a PERFECT parry. They warm from
 * orange to gold as they close and turn white-gold once landed. When the pumpkin is resolved they show how it went: a gold burst
 * outward (perfect), a soft fade (parry), or a red collapse (miss). Only you see yours: it hangs off your own ring's root.
 */
interface Approach {
  parent: Entity
  root: Entity
  beads: Entity[]
  colour: Colour | ''
  shown: boolean
  spin: number
  radius: number // last drawn while closing in: the outro starts from here
}
const APPROACH_LIFT = 0.06 // above the target ring, so the beads sit on it rather than in it
const APPROACH_SPIN_DEG_PER_S = -55 // turns the other way from the target ring
const OUTRO_MS = 320
const COLOURS = {
  far: Color4.create(1, 0.42, 0.05, 1),
  near: Color4.create(1, 0.72, 0.12, 1),
  landed: Color4.create(1, 0.95, 0.65, 1),
  miss: Color4.create(1, 0.12, 0.08, 1)
}
type Colour = keyof typeof COLOURS
let approach: Approach | undefined

function createApproach(parent: Entity): Approach {
  const root = engine.addEntity()
  Transform.create(root, { parent, position: Vector3.create(0, ringY() + APPROACH_LIFT, 0), scale: Vector3.Zero() })
  const beads: Entity[] = []
  for (let i = 0; i < APPROACH_RING_BEADS; i++) {
    const bead = engine.addEntity()
    Transform.create(bead, { parent: root })
    MeshRenderer.setSphere(bead)
    beads.push(bead)
  }
  return { parent, root, beads, colour: '', shown: false, spin: 0, radius: 0 }
}

function removeApproach() {
  if (!approach) return
  for (const bead of approach.beads) engine.removeEntity(bead)
  engine.removeEntity(approach.root)
  approach = undefined
}

/** Recolours the beads only when the colour changes (a few times per pumpkin, not every frame). */
function paint(a: Approach, colour: Colour) {
  if (a.colour === colour) return
  a.colour = colour
  const c = COLOURS[colour]
  for (const bead of a.beads) Material.setPbrMaterial(bead, { albedoColor: c, emissiveColor: c, emissiveIntensity: 2.4, castShadows: false })
}

function drawApproach(a: Approach, radius: number, beadSize: number, colour: Colour, dt: number) {
  paint(a, colour)
  a.spin = (a.spin + APPROACH_SPIN_DEG_PER_S * dt) % 360
  const root = Transform.getMutable(a.root)
  root.scale = Vector3.One()
  root.rotation = Quaternion.fromEulerDegrees(0, a.spin, 0)
  a.beads.forEach((bead, i) => {
    const angle = (i / a.beads.length) * Math.PI * 2
    const t = Transform.getMutable(bead)
    t.position = Vector3.create(Math.cos(angle) * radius, 0, Math.sin(angle) * radius)
    t.scale = Vector3.create(beadSize, beadSize, beadSize)
  })
  a.shown = true
}

/** Draws this frame's approach ring. `closing`: how far it still has to close (1 = just appeared, 0 = landed on the rim), undefined = no pumpkin of yours is close. */
function updateApproach(a: Approach, closing: number | undefined, dt: number) {
  const rim = TARGET_RING_RADIUS * APPROACH_RING_RIM
  const since = incoming.sinceOutcome()
  // A fresh outro plays unless the next pumpkin's ring is already well on its way (volleys can arrive close together)
  if (since < OUTRO_MS && (closing === undefined || closing > 0.6)) {
    const k = since / OUTRO_MS
    const ease = 1 - (1 - k) * (1 - k)
    const from = a.radius || rim
    const grade = incoming.outcome()
    if (grade === 'perfect') drawApproach(a, from * (1 + 0.7 * ease), APPROACH_RING_BEAD_SIZE * 1.3 * (1 - k), 'landed', dt)
    else if (grade === 'good') drawApproach(a, from * (1 + 0.25 * ease), APPROACH_RING_BEAD_SIZE * (1 - k), 'near', dt)
    else drawApproach(a, from * (1 - 0.5 * ease), APPROACH_RING_BEAD_SIZE * (1 - k), 'miss', dt)
    return
  }
  if (closing !== undefined) {
    a.radius = rim * (1 + (APPROACH_RING_START_SCALE - 1) * closing)
    const colour: Colour = closing === 0 ? 'landed' : closing < 0.45 ? 'near' : 'far'
    drawApproach(a, a.radius, APPROACH_RING_BEAD_SIZE * (0.45 + 0.55 * (1 - closing)), colour, dt)
    return
  }
  a.radius = 0
  if (a.shown) {
    Transform.getMutable(a.root).scale = Vector3.Zero() // hide once, not every frame
    a.shown = false
  }
}

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
        if (approach) Transform.getMutable(approach.root).position = Vector3.create(0, ringY() + APPROACH_LIFT, 0)
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

    // Your approach ring, on your own ring. It closes over the last APPROACH_RING_SECONDS before the perfect moment.
    const me = getPlayer()?.userId?.toLowerCase() ?? ''
    const mine = rings.get(me)
    if (approach && approach.parent !== mine?.root) removeApproach() // your ring was rebuilt (or is gone)
    if (mine && !approach) approach = createApproach(mine.root)
    const eta = incoming.eta()
    const untilPerfect = eta === undefined ? undefined : eta - PARRY_PERFECT_LEAD_MS / 1000
    const closing =
      me && targetId === me && untilPerfect !== undefined && untilPerfect <= APPROACH_RING_SECONDS ? Math.max(0, untilPerfect / APPROACH_RING_SECONDS) : undefined
    if (approach) updateApproach(approach, closing, dt)

    const wave = Math.sin(t * 6)
    for (const [id, r] of rings) {
      if (id !== targetId) {
        if (r.shown) {
          Transform.getMutable(r.ring).scale = Vector3.Zero() // hide once, not every frame
          r.shown = false
        }
        continue
      }
      r.shown = true
      const pulse = 1 + wave * PULSE * (id === me && closing !== undefined ? closing : 1)
      Transform.getMutable(r.ring).scale = Vector3.create(pulse, 1, pulse)
      r.spin = (r.spin + TARGET_RING_SPIN_DEG_PER_S * dt) % 360
      Transform.getMutable(r.spinner).rotation = Quaternion.fromEulerDegrees(0, r.spin, 0)
    }
  })
}
