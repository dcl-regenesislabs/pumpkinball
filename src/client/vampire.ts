import {
  Animator,
  Billboard,
  BillboardMode,
  ColliderLayer,
  engine,
  Entity,
  InputAction,
  InputModifier,
  MainCamera,
  Material,
  MaterialTransparencyMode,
  MeshCollider,
  MeshRenderer,
  pointerEventsSystem,
  Transform,
  VirtualCamera
} from '@dcl/sdk/ecs'
import { Color3, Color4, Quaternion, Vector3 } from '@dcl/sdk/math'
import { EntityNames } from '../../assets/scene/entity-names'
import { ARENA_CENTER, PlayerStatus } from '../shared/config'
import { PlayerState } from '../shared/schemas'
import { getPlayer } from '@dcl/sdk/src/players'
import { aheadOfPlayer, faceCameraAfter } from './cameraFace'
import { inCombat } from './controls'
import { parryFeedback } from './feedback'
import { playSfx, VAMPIRE_VOICE_SFX } from './sfx'
import { requestSoloStart } from './solo'
import { DialogMode, hooks, solo, vampireDialog } from './soloState'

/**
 * The Vampire waiting in the lobby. He idles, turns to you and talks when you click him, and his offer starts the
 * solo fight (client/solo.ts). Everything here is local to this client; the model comes from the editor.
 */

const TALK_RANGE = 9 // meters you can click him from
const LOOPING = ['idle', 'talk', 'kneel_idle', 'run']

const FRIENDS = 'a scarecrow with a temper, a skeleton who never stops grinning, a wizard and a witch who bicker about everything'

/** What the Vampire says, by how well you know each other. */
export function vampireLines(): string[] {
  const n = solo.cleared
  if (vampireDialog.mode === 'epilogue') {
    return [
      'Well, well... I did not expect that.',
      'You walked through my friends like they were scarecrows. Well. One of them was.',
      'Proving your power to me, on my own ring. Three hundred years, and nobody has managed that.',
      'Do not tell the others, but we had fun. The Wizzir has not stopped talking about that last volley.',
      'If you ever want to play again... just tell me.'
    ]
  }
  if (vampireDialog.mode === 'again') {
    const greetings = [
      ['Back for more? I admire the stubbornness. The gravestones admire the company.'],
      ['Ah, my favourite pumpkin-swinger. I was just polishing the ring for you.'],
      ['You smell of lava and poor decisions. Wonderful.']
    ]
    const g = greetings[vampireDialog.variant % greetings.length]
    return [...g, `You have cleared ${n} of 5 so far. Choose which of my friends gets the pleasure.`]
  }
  return [
    'Ahh... a visitor. Few climb this far. The moon is generous tonight.',
    'Three hundred years I have waited for someone worth the effort. Do you see these gravestones? Each one thought they were quick.',
    'The rules are simple. I throw the pumpkin. You swing it back. Land enough hits and I kneel. Miss, and I get to keep you.',
    `Oh, and I brought friends: ${FRIENDS}. They get competitive.`,
    'Five fights. Each one dirtier than the last. Well, mortal? Do you have the nerve?'
  ]
}

let entity: Entity | undefined
let baseRotation = Quaternion.Identity()
let hitbox: Entity | undefined

/** Plays one clip on the lobby Vampire (looping ones loop). */
function play(clip: string) {
  if (!entity || !Animator.has(entity)) return
  const states = Animator.getMutable(entity).states
  for (const s of states) {
    s.loop = LOOPING.includes(s.clip)
    // The editor wrote weight -1 into these states; some explorers (phones) then blend the pose wrongly, with the arms up.
    // Fight bosses are built without it and look right everywhere, so give these the same plain values.
    s.weight = 1
    s.speed = 1
  }
  Animator.playSingleAnimation(entity, clip, true)
}

export function openVampireDialog(mode?: DialogMode) {
  if (vampireDialog.open || solo.active || solo.starting) return
  vampireDialog.mode = mode ?? (solo.cleared > 0 ? 'again' : 'intro')
  vampireDialog.variant = Math.floor(Math.random() * 3)
  vampireDialog.open = true
  vampireDialog.line = 0
  play('talk')
  playSfx(VAMPIRE_VOICE_SFX, 0.9)
}

export function closeVampireDialog() {
  if (!vampireDialog.open) return
  vampireDialog.open = false
  play('idle')
  if (entity) Transform.getMutable(entity).rotation = baseRotation
}

/** A "Fight" button on the last line: begin at `level` (1 unless you have cleared more). */
export function acceptVampireFight(level = 1) {
  const me = getPlayer()?.userId?.toLowerCase()
  let status: string = PlayerStatus.Idle
  for (const [, p] of engine.getEntitiesWith(PlayerState)) if (p.playerId === me) status = p.status
  closeVampireDialog()
  if (status === PlayerStatus.Alive) {
    parryFeedback.notice('Finish your match first')
    return
  }
  requestSoloStart(Math.max(1, Math.min(level, solo.cleared + 1)))
}

// ---- The closing talk: a forced camera framing the Vampire and the player together ----

const TALK_CAM_NEAR = 7 // the camera takes over once the player is this close to him (the server brings them over)
const TALK_CAM_DISTANCE = 4.6 // to the side of the two of them
let talkCam: Entity | undefined
let talkCamOn = false
let talkCamCleanup = 0

function takeTalkCamera() {
  if (!talkCam) {
    // One entity for the whole session, never removed (the explorer blends back from it; see solo.ts)
    talkCam = engine.addEntity()
    Transform.create(talkCam, { position: Vector3.Zero() })
  }
  talkCamCleanup = 0
  talkCamOn = true
}

function dropTalkCamera() {
  if (!talkCamOn) return
  talkCamOn = false
  InputModifier.deleteFrom(engine.PlayerEntity)
  MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: undefined })
  faceCameraAfter(aheadOfPlayer()) // behind the avatar, level, not pitched down
  talkCamCleanup = 2 // the camera component goes a little later, once the blend back to the player is done
}

/** Puts the camera beside the Vampire and the player, looking at the middle of them. Returns false until it can be placed. */
function aimTalkCamera(vampire: Vector3, started: boolean): boolean {
  const me = Transform.getOrNull(engine.PlayerEntity)?.position
  if (!me || !talkCam) return false
  const flat = Vector3.create(me.x - vampire.x, 0, me.z - vampire.z)
  const dist = Vector3.length(flat)
  if (dist > TALK_CAM_NEAR || dist < 0.2) return false
  const dir = Vector3.normalize(flat)
  // Beside the two of them, on whichever side lands closer to the middle of the balcony (it curves around the arena, about
  // 33 to 48 m from its centre), so the camera is over floor and not out past the rail or the back wall
  const mid = Vector3.create((vampire.x + me.x) / 2, vampire.y + 1.55, (vampire.z + me.z) / 2)
  const left = Vector3.create(dir.z, 0, -dir.x)
  const right = Vector3.scale(left, -1)
  const midRadius = 40.5
  const offBy = (s: Vector3) =>
    Math.abs(Math.hypot(mid.x + s.x * TALK_CAM_DISTANCE - ARENA_CENTER.x, mid.z + s.z * TALK_CAM_DISTANCE - ARENA_CENTER.z) - midRadius)
  const side = offBy(left) <= offBy(right) ? left : right
  const eye = Vector3.create(mid.x + side.x * TALK_CAM_DISTANCE, mid.y + 0.7, mid.z + side.z * TALK_CAM_DISTANCE)
  const t = Transform.getMutable(talkCam)
  t.position = eye
  t.rotation = Quaternion.lookRotation(Vector3.subtract(mid, eye))
  if (!started) {
    VirtualCamera.createOrReplace(talkCam, { defaultTransition: { transitionMode: VirtualCamera.Transition.Time(0.7) }, fov: 55 })
    MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: talkCam })
    InputModifier.createOrReplace(engine.PlayerEntity, { mode: InputModifier.Mode.Standard({ disableAll: true }) })
  }
  return true
}

// ---- The "Solo Adventure" sign over his head, so players know they can talk to him ----

export const SOLO_SIGN_IMAGE = 'assets/images/SoloAdventure.png'
const SIGN_WIDTH = 3.3 // metres (the image is 16:9)
const SIGN_HEIGHT = SIGN_WIDTH * (941 / 1672)
const SIGN_ABOVE_HEAD = 0.25 // gap between the top of his head and the bottom of the sign
const VAMPIRE_HEIGHT = 2.23 * 1.41 // metres, standing (model height times the scale he is placed at)
const SIGN_BOB = 0.15
let signShown = 0

function makeSign(): Entity {
  const e = engine.addEntity()
  Transform.create(e, { scale: Vector3.Zero() })
  MeshRenderer.setPlane(e)
  // Alpha-blended and self-lit like the join sign, so it reads clearly day or night
  Material.setPbrMaterial(e, {
    texture: Material.Texture.Common({ src: SOLO_SIGN_IMAGE }),
    emissiveTexture: Material.Texture.Common({ src: SOLO_SIGN_IMAGE }),
    emissiveColor: Color3.White(),
    emissiveIntensity: 1,
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    roughness: 1,
    metallic: 0,
    specularIntensity: 0
  })
  Billboard.create(e, { billboardMode: BillboardMode.BM_Y })
  return e
}

export function setupVampire() {
  hooks.epilogue = () => openVampireDialog('epilogue')
  let ready = false
  let camPlaced = false
  let sign: Entity | undefined
  let time = 0
  engine.addSystem((dt: number) => {
    time += dt
    // forced camera only for the closing talk; then everything is free again
    if (vampireDialog.open && vampireDialog.mode === 'epilogue' && entity) {
      const vp = Transform.getOrNull(entity)?.position
      if (vp) {
        takeTalkCamera()
        camPlaced = aimTalkCamera(vp, camPlaced) || camPlaced
      }
    } else if (talkCamOn) {
      camPlaced = false
      dropTalkCamera()
    }
    if (talkCamCleanup > 0) {
      talkCamCleanup -= dt
      if (talkCamCleanup <= 0 && talkCam && !talkCamOn) VirtualCamera.deleteFrom(talkCam)
    }

    if (!entity) {
      entity = engine.getEntityOrNullByName(EntityNames.Vampire_glb) ?? undefined
      if (!entity) return
    }
    const t = Transform.getOrNull(entity)
    if (!t) return

    if (!ready) {
      ready = true
      baseRotation = Quaternion.create(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w)
      play('idle')

      // The model's own meshes carry no pointer collider, so click an invisible box around him instead.
      hitbox = engine.addEntity()
      Transform.create(hitbox, { position: Vector3.create(t.position.x, t.position.y + 1.4, t.position.z), scale: Vector3.create(1.8, 2.8, 1.8) })
      MeshCollider.setBox(hitbox, ColliderLayer.CL_POINTER)
      pointerEventsSystem.onPointerDown(
        { entity: hitbox, opts: { button: InputAction.IA_POINTER, hoverText: 'Talk to the Vampire', maxDistance: TALK_RANGE } },
        () => openVampireDialog()
      )
    }

    // The sign: shown while nobody is talking to him and you are not in a game, fading in and out
    if (!sign) sign = makeSign()
    const visible = !solo.active && !solo.starting && !vampireDialog.open && !inCombat()
    signShown += ((visible ? 1 : 0) - signShown) * Math.min(1, 4 * dt)
    const st = Transform.getMutable(sign)
    const bob = Math.sin(time * 2.1) * SIGN_BOB
    st.position = Vector3.create(t.position.x, t.position.y + VAMPIRE_HEIGHT + SIGN_ABOVE_HEAD + SIGN_HEIGHT / 2 + bob, t.position.z)
    const k = signShown < 0.01 ? 0 : 0.9 + 0.1 * signShown
    st.scale = Vector3.create(SIGN_WIDTH * k, SIGN_HEIGHT * k, 1)
    const sm = Material.getMutable(sign)
    if (sm.material?.$case === 'pbr') {
      sm.material.pbr.albedoColor = Color4.create(1, 1, 1, signShown)
      sm.material.pbr.emissiveIntensity = signShown
    }

    // While he talks, he turns to face the player
    if (vampireDialog.open) {
      const me = Transform.getOrNull(engine.PlayerEntity)?.position
      if (me) {
        const flat = Vector3.create(me.x - t.position.x, 0, me.z - t.position.z)
        if (Vector3.length(flat) > 0.1) Transform.getMutable(entity).rotation = Quaternion.lookRotation(flat)
      }
    }
  })
}
