import { Vector3 } from '@dcl/sdk/math'

// Layout comes from the models placed in the editor (assets/scene/main.composite). If you move or rescale them
// there, update these numbers to match. All models sit at the scene center (80, 80); y is the height of their floor.
//
// ArenaRing.glb: 44 m disc, top surface at height 5, with a collider.
export const ARENA_FLOOR_Y = 5
export const ARENA_CENTER = Vector3.create(80, ARENA_FLOOR_Y, 80)
export const ARENA_RADIUS = 22
export const ARENA_SPAWN_RADIUS = 16

// Balcony.glb: a curved gallery north of the arena (about 33 to 48 m from its center), floor at height 11.4.
export const LOBBY_Y = 11.4
// StartGame.glb (placed at 80, 11.25, 117.826, scale 1): standing on it queues you. Pad radius = 4.1. The join radius
// is a little larger than the model so players on the rim or landing from a jump are always accepted.
export const LOBBY_CENTER = Vector3.create(80, LOBBY_Y, 117.826)
export const JOIN_PAD_RADIUS = 4.4
export const JOIN_PAD_LEAVE_RADIUS = 5.4 // once queued you only drop out beyond this (hysteresis), or after the grace below
export const JOIN_PAD_LEAVE_GRACE_MS = 600 // brief position hiccups (jumping, lag) never un-queue anyone
export const LOBBY_SPAWN = Vector3.create(80, LOBBY_Y + 0.5, 123.5) // behind the pad, facing the arena
// The scene's spawn area (scene.json spawnPoints: x 77.5-82.5, z 122.54-127.54, y 11.9). Strays are sent back here.
// Keep these in sync if you move the spawn in scene.json.
export const SCENE_SPAWN = { xMin: 77.5, xMax: 82.5, zMin: 122.54, zMax: 127.54, y: 11.9 }
/** A random spot in the spawn area that is clearly outside the join pad, so arriving never puts anyone in the queue. */
export const sceneSpawnPoint = () => {
  const minDist = JOIN_PAD_LEAVE_RADIUS + 0.5 // outside even the forgiving "already queued" radius
  for (let i = 0; i < 12; i++) {
    const x = SCENE_SPAWN.xMin + Math.random() * (SCENE_SPAWN.xMax - SCENE_SPAWN.xMin)
    const z = SCENE_SPAWN.zMin + Math.random() * (SCENE_SPAWN.zMax - SCENE_SPAWN.zMin)
    if (Math.hypot(x - LOBBY_CENTER.x, z - LOBBY_CENTER.z) >= minDist) return Vector3.create(x, SCENE_SPAWN.y, z)
  }
  return Vector3.create(LOBBY_SPAWN.x, SCENE_SPAWN.y, LOBBY_SPAWN.z + 1.5) // fallback: back of the spawn area
}
// Anyone who is not playing and is lower than this (the arena floor, the lava, the ring, the ground) is not in the lobby.
export const LOBBY_MIN_Y = LOBBY_Y - 2.5
export const SPECTATOR_SPOT = Vector3.create(68, LOBBY_Y + 0.5, 113) // eliminated players watch from the inner edge

// Lava.glb: a flat moat around the arena at height 0.41. Touching it eliminates you. Its exact outline is in
// shared/lavaShape.ts (generated from the model: run `npm run lava` after reshaping or moving it in the editor).
export const LAVA_SURFACE_Y = 0.41
export const LAVA_KILL_Y = LAVA_SURFACE_Y + 0.5 // feet below this over the lava = touching it

// Safety net in case the ring's edge and the lava leave a gap: dropping this far below the ring near it is also out.
export const FALL_NET_DEPTH = 2.5
export const FALL_NET_RANGE = 12 // metres beyond the ring's radius

export const MAX_HP = 3 // hits a player can take before elimination

// Touching the lava is an instant loss; ignored briefly after a round starts while teleports land.
export const FALL_GRACE_MS = 3000

export const FEED_TTL_MS = 12000 // how long a recap line stays on screen

export const COUNTDOWN_SECONDS = 10
export const STARTING_SECONDS = 3 // players are on the arena and the 3-2-1 plays before the pumpkin is released
export const ROUND_MAX_SECONDS = 120
export const WINNER_SECONDS = 8 // includes the winner's dance and the orbiting camera

export const Phase = {
  Lobby: 'lobby',
  Countdown: 'countdown',
  Starting: 'starting',
  Round: 'round',
  Winner: 'winner'
} as const

export const PlayerStatus = {
  Idle: 'idle',
  Queued: 'queued',
  Alive: 'alive',
  Out: 'out',
  Solo: 'solo' // playing alone against the Vampire in the ring (local game; the server only tracks who is in it)
} as const

// Dev switch: lets a single player start a round. Keep false for real play (a round needs 2+ players).
export const SOLO_TEST = false
// Shows the press/resolve/server debug lines on the HUD. Handy while playtesting; set false for release.
export const DEBUG_HUD = false
export const MIN_PLAYERS = SOLO_TEST ? 1 : 2

// Pumpkin tuning. Constant visible speed while it flies, so it feels the same at any distance.
export const PUMPKIN_BASE_SPEED = 8 // m/s at the start of a chain
export const PARRY_SPEED_STEP = 1.5 // m/s added per successful parry
export const PUMPKIN_ACCEL = 0.6 // m/s gained per second in flight, so running away can't work forever
export const PUMPKIN_MAX_SPEED = 26
export const PUMPKIN_HIT_RADIUS = 1 // "arrived" distance (client and server)
export const PUMPKIN_AIM_HEIGHT = 1 // aim at chest, not feet
export const PUMPKIN_LAUNCH_DELAY = 0.5 // seconds the pumpkin hovers before its first launch (the 3-2-1 already gave players time)

// Parry / hit resolution. The TARGET's client decides, from what it sees; the server validates.
export const PARRY_SWING_MS = 250 // client: a press keeps the swing 'live' this long (early-press tolerance)
export const PARRY_LATE_GRACE_S = 0.05 // client: after the pumpkin reaches you, this long to still parry (the decision is local, so this stays tiny)
export const PUMPKIN_CONTACT_RADIUS = 0.7 // client: the pumpkin 'reaches you' at this distance from your chest
export const PARRY_COOLDOWN_MS = 800 // starts on every press; a SUCCESSFUL parry refunds it, so only whiffs are punished
export const LOBBY_SWING_COOLDOWN_MS = 600 // fun swing in the lobby: no game effect, just keeps it from being spammed
export const PARRY_BUFFER_MS = 200 // a press this close to the cooldown ending is remembered and fired when it ends
export const SERVER_COOLDOWN_TOLERANCE = 0.85 // server accepts a press at 85% of the cooldown (network jitter)
export const SERVER_SWING_VALID_MS = 1500 // a parry claim needs a matching press this recent
export const SERVER_PLAUSIBLE_S = 1.5 // claim is rejected if the server's own ball is further than this from impact
export const SERVER_FALLBACK_S = 1.2 // no report this long after the server's ball arrives: the server applies the hit

// Weapon held in the right hand. Currently the baseball bat (origin ~17 cm above the knob, length along +Y).
// To switch back to the official sword: model 'assets/models/sword.glb', scale 0.7, offset y 0.1, roll 90.
export const PARRY_EMOTE_SRC = 'assets/models/sword_attack_emote.glb' // must end with _emote.glb
export const SWORD_MODEL = 'assets/models/BaseballBat.glb'
export const SWORD_SCALE = 0.85 // the bat model is ~0.98 m long
// WHERE the bat sits in the hand, in metres, along the hand's own axes (the anchor is at the wrist). Edit the numbers, save,
// and the running preview reloads. Change one value at a time, by 0.02-0.05, and look at it from the side and from above:
//   y: along the arm. + moves the bat toward the fingers (down), - back toward the wrist. Slides the grip up/down the handle.
//   x, z: across the hand, so the bat sits more to the palm side or the back of the hand. If one of them moves it the wrong
//   way, just use the opposite sign. If the bat clips the leg/hip, move it away from the body with these.
export const SWORD_OFFSET = { x: 0.02, y: 0.1, z: 0.05 }
export const SWORD_ROLL_DEGREES = 0 // spin around the weapon's own axis (a round bat looks the same at any roll)
// Orientation of the weapon in the hand. x 90 = out forward. Tilting x (45/135) was wrong: it pointed the bat up/down the arm.
// y turns it sideways around the arm (currently tuned by eye). z is the other sideways tilt.
export const SWORD_ROTATION_DEGREES = { x: 90, y: -21, z: 0 }

// Pumpkin model: now ~0.37 m wide with its origin near the middle. Scaled x2.4 to ~0.9 m so it reads in a 44 m arena;
// set PUMPKIN_MODEL_SCALE to 1 (and OFFSET_Y to -0.065) to use it at its authored size.
export const PUMPKIN_MODEL = 'assets/models/pumpkin.glb'
export const PUMPKIN_MODEL_SCALE = 2.4
export const PUMPKIN_MODEL_OFFSET_Y = -0.156 // centers the model's middle (it sits 0.065 above its origin) on the ball position
// Tumble rates (degrees per second) around each axis. A pumpkin is nearly round, so turning it only around
// the vertical axis is barely visible; turning on all three reads as rolling/tumbling.
export const PUMPKIN_TUMBLE_DEG_PER_S = { x: 260, y: 190, z: 140 }
export const PUMPKIN_BOB_HEIGHT = 0.07 // small vertical bob so it feels alive even while hovering

export const BAT_ICON = 'assets/images/Bat.png' // parry button icon (desktop button + mobile main button)


// Optional custom texture for the target ring on the ground (a transparent PNG, e.g. 'assets/images/ring.png').
// Empty string = use the built-in ring of glowing beads.
export const TARGET_RING_MODEL = 'assets/models/TargetRing.glb' // flat ring decal, radius 1 in the model
// Extra height for the target ring on the desktop (Unity) client, whose avatar attach point sits lower than Bevy's. Found with
// RING_CALIBRATION: when true, keys 1 / 2 move the ring up / down by 10 cm on desktop and the value is shown on screen.
export const TARGET_RING_UNITY_OFFSET_Y = 0.55 // found by hand: 5-6 presses of the raise key
export const RING_CALIBRATION = false // set true to tune it again (desktop: keys 1 / 2, your own ring always visible)
export const TARGET_RING_SPIN_DEG_PER_S = 110 // how fast it turns while it marks the hunted player
export const TARGET_RING_RADIUS = 1.2

// Models that move slowly on their own: they turn around their vertical axis (they are centered on the arena, so
// they circle it) and can optionally bob up and down. Closer layers move faster than distant ones.
//   degPerSecond: positive and negative turn opposite ways (0.3 deg/s = one full turn every 20 minutes)
//   bobMeters / bobPeriodSeconds: how far up and down, and how long one full up-and-down takes (omit for no bobbing)
export const SPINNING_MODELS: { name: string; degPerSecond: number; bobMeters?: number; bobPeriodSeconds?: number }[] = [
  { name: 'Sky.glb', degPerSecond: 1.5 },
  // Ordered closest to farthest (by size): speed and bobbing both slow down with distance. The farthest layer
  // turns at 0.5 deg/s (one full turn every 12 minutes); the closer ones are faster.
  { name: 'Clouds01.glb', degPerSecond: 2.5, bobMeters: 1.2, bobPeriodSeconds: 40 }, // 91 m wide
  { name: 'Clouds03.glb', degPerSecond: -2.0, bobMeters: 1.8, bobPeriodSeconds: 60 }, // 109 m
  { name: 'Clouds02.glb', degPerSecond: 1.5 }, // 124 m
  { name: 'Clouds04.glb', degPerSecond: -1.1, bobMeters: 2.2, bobPeriodSeconds: 90 }, // 161 m
  { name: 'Clouds06.glb', degPerSecond: 0.8, bobMeters: 2.5, bobPeriodSeconds: 110 }, // 161 m
  { name: 'Clouds05.glb', degPerSecond: -0.5 } // 185 m, the farthest
]

// Time of day for the whole scene, in seconds since midnight (0 = midnight, 64800 = 6 PM dusk, 75600 = 9 PM,
// 43200 = noon). Daylight washes out coloured lights, so the scene is set to night. Set to -1 to leave the
// default day/night cycle alone.
export const SKYBOX_FIXED_TIME = 75600

// Real lights (see client/lights.ts). Colours are RGB 0..1; intensity is in candela (a default light = 16000);
// range is how far the light reaches, in metres. Light fades with the square of distance, so far-away lights
// (the moon) need much more intensity.
//
// IMPORTANT: the explorer only draws the lights nearest to the player (about 4 to 10, depending on the graphics
// quality setting). More lights than that does not mean more lighting: the far ones get dropped whenever others
// are closer. So the lava and moon lights are OFF, and only the 4 balcony pillars get a real light (the outer ones cost performance).
export const LIGHTS = {
  // Magenta-red on the flame of every Pillar01.glb (was purple 0.72, 0.3, 1). flameLocalY is the flame's height in the model's own units
  // (the light follows the pillar's scale). Pillars scaled at or above onlyBelowScale are skipped: 0.6 lights only the
  // small balcony pillars (scale 0.41) and skips the big outer ones (0.8), which kept costing performance. 99 = light all.
  pillar: { color: { r: 0.95, g: 0.2, b: 0.5 }, intensity: 50000, range: 24, flameLocalY: 16, onlyBelowScale: 0.6 },
  // Green: a ring of lights just above the lava around the arena. Off: it competed with the pillars for the budget.
  lava: { enabled: false, color: { r: 0.3, g: 1, b: 0.1 }, intensity: 90000, range: 42, count: 3, radius: 28, height: 2 },
  // Blue-white from the moon (far away, so it needs a lot of power). Off, for the same reason.
  moon: { enabled: false, color: { r: 0.75, g: 0.88, b: 1 }, intensity: 1500000, range: 150 }
}

// Leaderboard (Leaderboard.glb): the players with the most match wins, as a table:
//   RANK   (face) NAME   WINS
// Layout is in the model's own units (metres). The wooden panel spans x -3.65..3.65 and y 1.54..8.82, with the title
// banner above it. Column positions (rankU, faceU, nameU, winsU) are measured from the viewer's point of view:
// negative = left, positive = right. The code mirrors them per board face, so it reads left to right from both sides.
export const LEADERBOARD = {
  rows: 7,
  headerY: 8.0, // the RANK / NAME / WINS header line
  firstRowY: 7.15, // height of the first player's row
  rowHeight: 0.78,
  rankU: -2.95, // rank starts here (left-aligned)
  faceU: -2.0, // avatar face, centred here
  faceSize: 0.66,
  nameU: -1.5, // names start here (left-aligned)
  winsU: 3.0, // win counts end here (right-aligned)
  frontOffset: 0.3, // how far text sits in front of the board surface
  frontTextYaw: 180, // turn of the text on the +Z (balcony-facing) side. If the text reads mirrored, change 180 to 0.
  rowFontSize: 4,
  headerFontSize: 2.6,
  maxNameLength: 14 // longer names are cut with ...
}

// Winner cinematic: the winner dances and every camera orbits around them for the length of the winner phase.
export const WINNER_DANCE_EMOTE = 'dance'
// The camera stands on the arena side of the winner (always open space), looks at them, and slowly zooms in.
export const WINNER_CAMERA = { startDistance: 7.5, endDistance: 3.6, height: 1.7, lookAtHeight: 1.25 }

// ---- Single player (the Vampire) ----
// The ring is shared: a solo run is a local game on the same arena. Other players never see its pumpkin, boss or hazards
// (they are not synced), and avatars are hidden per viewer with an AvatarModifierArea (client/soloVisibility.ts).
// Box over the ring that hides avatars. It must NOT reach the balcony (z from about 113) or the spectator spot.
export const SOLO_RING_AREA = {
  center: Vector3.create(80, ARENA_FLOOR_Y + 8, 80),
  size: Vector3.create(50, 16, 50)
}
// Where a player who just beat the whole solo run stands when the Vampire talks to them, and where he stands (the lobby NPC placed
// in the editor). On the balcony, clear of the join pad.
export const VAMPIRE_LOBBY_POS = Vector3.create(101, 11.25, 114.5) // fallback: the server reads his real placement from the scene
export const LOBBY_VAMPIRE_SPOT = Vector3.create(98, 11.9, 116.2) // fallback: about 3.4 m in front of him
export const VAMPIRE_TALK_DISTANCE = 3.4 // how far in front of him a player is brought for the closing talk
export const SOLO_SPAWN = Vector3.create(80, ARENA_FLOOR_Y + 0.5, 84) // where a solo player lands, facing the boss
export const SOLO_BOSS_POS = Vector3.create(80, ARENA_FLOOR_Y, 69)
export const VAMPIRE_MODEL = 'assets/models/npcs/Vampire.glb'
export const VAMPIRE_SCALE = 1.41 // same as the lobby Vampire placed in the editor
export const VAMPIRE_BOSS_HP = 3 // hits to defeat him (level 1)
// ---- Vampire tuning: change a number, save, and the preview reloads ----
export const VAMPIRE_HAND_Y = 4.2 // how high the pumpkin appears while he charges it, above his feet (his raised hand during blast_left)
export const VAMPIRE_STRIKE_Y = 1.3 // height the pumpkin comes back to and leaves from after the throw: about player height
export const VAMPIRE_HAND_FORWARD = 0.5 // metres toward the player from his centre
export const VAMPIRE_HAND_SIDE = 0 // metres to his side (try 0.6 or -0.6 to line it up with the left hand)
export const VAMPIRE_BODY_Y = 2.0 // where hits on him burst (his chest)
export const VAMPIRE_APPEAR_S = 0.8 // he grows in with the spawn effect
// Vampire clip lengths in seconds (read from the model)
export const VAMPIRE_CLIPS = { blast_left: 1.96, swing: 1.29, hurt: 0.71, kneel: 1.79 }
export const VAMPIRE_BLAST_APPEAR_S = 0.3 // into blast_left: the pumpkin shows up in his hand and starts charging
export const PUMPKIN_CHARGE_START_SCALE = 0.2 // how small it starts; the charging energy grows it to full size by the throw
export const VAMPIRE_BLAST_LAUNCH_S = 1.5 // into blast_left: the pumpkin is thrown
export const VAMPIRE_SWING_SPEED = 1.8 // his swing animation plays this many times faster
export const VAMPIRE_SWING_HIT_S = 0.45 / VAMPIRE_SWING_SPEED // seconds into the (sped-up) swing when the bat connects and the pumpkin goes back
export const VAMPIRE_RUN_SPEED = 7 // m/s when he relocates after being hit
export const VAMPIRE_RUN_ANIM_SPEED = 1.6 // his run animation plays this many times faster (raise it if his feet look slow for the ground he covers)
export const VAMPIRE_ROAM_AFTER_HITS = 2 // from this many hits on him he keeps running around the ring even while the pumpkin is in play
export const VAMPIRE_MOVE_RADIUS = { min: 9, max: 16 } // where he may stand, distance from the ring's centre
export const VAMPIRE_MOVE_MIN_FROM_PLAYER = 9 // he never relocates closer than this to you
export const VAMPIRE_MOVE_MIN_DISTANCE = 6 // and always moves at least this far

// Testing: shows the level buttons (1-5) and the KILL 1 button in the solo HUD. Off for now; set true to bring them back.
export const SOLO_LEVEL_SELECT = false

// Level intro: a camera shows the bosses rising out of the floor before they start moving.
export const INTRO_FIRST_SPAWN_S = 0.7 // before the first boss appears
export const INTRO_STAGGER_S = 0.5 // between bosses
export const INTRO_RISE_S = 0.9 // a boss rising out of the floor
export const INTRO_HOLD_S = 1.3 // after the last one is up, before the fight starts

// Marker ring under every boss (NPCTargetRing.glb: a flat ring of radius 1), so they are easy to spot on the arena at night.
export const NPC_RING_MODEL = 'assets/models/NPCTargetRing.glb'
export const NPC_RING_RADIUS = 1.7 // metres for a normal-sized boss (scales with the boss, so the Vampire Master gets a bigger one)
export const NPC_RING_SPIN_DEG_PER_S = 70
export const NPC_RING_LIFT = 0.1 // above the floor
// A boss flashes red for an instant when a pumpkin hits him.
export const NPC_HURT_FLASH_S = 0.18
