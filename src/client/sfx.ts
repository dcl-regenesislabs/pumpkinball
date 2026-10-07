import { AudioSource, engine, Entity, Transform } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { sfxPrefs } from './music'

export const SWING_SFX = 'assets/sounds/Swing.wav'
export const BAT_HIT_SFX = 'assets/sounds/BatHit.wav'
export const HURT_SFX = 'assets/sounds/Hurt.wav'
export const TELEPORT_SFX = 'assets/sounds/teleport.wav'
export const EVIL_LAUGH_SFX = 'assets/sounds/EvilLaugh.wav'
export const WIN_SFX = 'assets/sounds/Win.wav'
export const BOO_SFX = 'assets/sounds/BOO.wav'
export const HOVER_SFX = 'assets/sounds/hover.wav'
export const CLOCK_TICK_SFX = 'assets/sounds/ClockTick.wav'
export const START_GO_SFX = 'assets/sounds/StartGo.wav'
export const PUMPKIN_CAST_SFX = 'assets/sounds/pumpkincast.wav' // a boss charging a pumpkin (2 s)
export const MAGIC_SPELL_SFX = 'assets/sounds/magicspell.wav' // a spell that is not a pumpkin: green orbs (0.9 s)
export const MAGIC_SPELL2_SFX = 'assets/sounds/magicspell2.wav' // a shorter one: floor circles, each orb as it leaves (0.5 s)
export const VAMPIRE_VOICE_SFX = 'assets/sounds/vampirevoice.wav' // the Vampire speaking (0.5 s)

/**
 * One-shot sound effects, clients only (same pattern as the Marsh Colony UI click: a lazily created AudioSource entity
 * retriggered with AudioSource.playSound). Your own sounds are flat; other players' are placed where they happen so
 * they get quieter with distance. The sound panel has their own volume and mute.
 */
const own = new Map<string, Entity>()
const playedAt = new Map<string, number>()

/** Milliseconds since this sound last started (Infinity if it never did). */
export const msSincePlayed = (src: string) => (playedAt.has(src) ? Date.now() - (playedAt.get(src) as number) : Infinity)
const positional = new Map<string, Entity>() // one spot-sound entity per clip, so two sounds at once never cut each other off

/** Plays a sound at the same volume wherever the player is. */
export function playSfx(src: string, volume = 0.8): void {
  playedAt.set(src, Date.now())
  if (sfxPrefs.muted()) return
  volume *= sfxPrefs.volume()
  let entity = own.get(src)
  if (!entity) {
    entity = engine.addEntity()
    Transform.create(entity, {})
    AudioSource.create(entity, { audioClipUrl: src, playing: false, global: true, volume })
    own.set(src, entity)
  }
  AudioSource.getMutable(entity).volume = volume
  AudioSource.playSound(entity, src)
}

/** Plays a sound at a spot in the scene (other players' swings and hits). */
export function playSfxAt(src: string, at: Vector3, volume = 0.8): void {
  playedAt.set(src, Date.now())
  if (sfxPrefs.muted()) return
  volume *= sfxPrefs.volume()
  let entity = positional.get(src)
  if (!entity) {
    entity = engine.addEntity()
    Transform.create(entity, { position: at })
    AudioSource.create(entity, { audioClipUrl: src, playing: false, global: false, volume })
    positional.set(src, entity)
  }
  Transform.getMutable(entity).position = at
  AudioSource.createOrReplace(entity, { audioClipUrl: src, playing: false, global: false, volume })
  AudioSource.playSound(entity, src)
}

/**
 * Preload: create every effect's audio entity at scene start (silent, not playing) so the clips are fetched and decoded
 * before the first time they are needed. Without this the first swing / hit / teleport can lag or drop.
 */
export function preloadSfx(): void {
  const flat = [SWING_SFX, BAT_HIT_SFX, HURT_SFX, TELEPORT_SFX, EVIL_LAUGH_SFX, WIN_SFX, BOO_SFX, CLOCK_TICK_SFX, START_GO_SFX, PUMPKIN_CAST_SFX, MAGIC_SPELL_SFX, MAGIC_SPELL2_SFX, VAMPIRE_VOICE_SFX]
  for (const src of flat) {
    if (own.has(src)) continue
    const entity = engine.addEntity()
    Transform.create(entity, {})
    AudioSource.create(entity, { audioClipUrl: src, playing: false, global: true, volume: 0 })
    own.set(src, entity)
  }
  // the ones also played at a spot in the world (other players' hits, the boomerang pumpkins)
  for (const src of [BAT_HIT_SFX, HURT_SFX, BOO_SFX]) {
    if (positional.has(src)) continue
    const entity = engine.addEntity()
    Transform.create(entity, { position: Vector3.Zero() })
    AudioSource.create(entity, { audioClipUrl: src, playing: false, global: false, volume: 0 })
    positional.set(src, entity)
  }
}
