import { AudioSource, engine, InputAction, inputSystem, PointerEventType, Transform } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { Phase } from '../shared/config'
import { room } from '../shared/messages'
import { GameState } from '../shared/schemas'
import { isMobile } from './platform'
import { solo } from './soloState'
import { isServerAlive } from './serverReadiness'

export const LOBBY_MUSIC = 'assets/sounds/lobby-music.mp3'
export const MUSIC_ICONS = { on: 'assets/images/SoundOn.png', off: 'assets/images/SoundOff.png' }
export const SOUND_MENU_ICON = 'assets/images/SoundOn.png' // the same icon as the desktop sound button: opens the panel
export const ARENA_MUSIC = 'assets/sounds/arena-music.mp3'

const DEFAULT_VOLUME = 0.3
const ARENA_BOOST = 1.7 // the arena track is mastered quieter than the lobby one: scale it up to match
const trackLevel = (clip: string) => (clip === ARENA_MUSIC ? ARENA_BOOST : 1)
const outVolume = (clip: string, gain: number) => Math.min(1, volume * trackLevel(clip) * gain)
const DEFAULT_SFX_VOLUME = 0.6
const VOLUME_STEP = 0.1
const ARENA_FADE_PER_SECOND = 3 // ~0.3 s each way when switching into or out of the arena track
const SAVE_AFTER_MS = 1500 // wait for the player to stop adjusting before saving
const FADE_PER_SECOND = 0.7 // crossfade speed: a full fade takes ~1.4 s

let volume = DEFAULT_VOLUME
let muted = false
let sfxVolume = DEFAULT_SFX_VOLUME
let sfxMuted = false

/** The sound panel (drawn in ui.tsx). On phones the explorer's native "+" menu opens it (see controls.ts). */
export const soundPanel = {
  open: false,
  toggle: () => {
    soundPanel.open = !soundPanel.open
  }
}
// On phones the sound entry is a single action (3) shown by the explorer, away from the bat; it opens the sound panel.
export const SOUND_TOUCH_ACTION = InputAction.IA_ACTION_3

let userTouched = false // the player changed something before their saved settings arrived: theirs wins
const markTouched = () => {
  userTouched = true
}

/** Sound effects (swing, hits, teleport, hover...): their own volume and mute, separate from the music. */
export const sfxPrefs = {
  volume: () => sfxVolume,
  muted: () => sfxMuted,
  percent: () => (sfxMuted ? 0 : Math.round(sfxVolume * 100)),
  /** Multiplier applied to every effect's own level. */
  scale: () => (sfxMuted ? 0 : sfxVolume),
  toggleMute: () => {
    markTouched()
    sfxMuted = !sfxMuted
    if (!sfxMuted && sfxVolume <= 0) sfxVolume = DEFAULT_SFX_VOLUME
  },
  setVolume: (v: number) => {
    markTouched()
    sfxMuted = false
    sfxVolume = Math.max(0, Math.min(1, Math.round(v * 10) / 10))
  }
}

export const music = {
  volume: () => volume,
  muted: () => muted,
  /** What the player hears as a percent (0 when muted). */
  percent: () => (muted ? 0 : Math.round(volume * 100)),
  toggleMute: () => {
    markTouched()
    muted = !muted
    // unmuting at zero volume would still be silent: give it the default back
    if (!muted && volume <= 0) volume = DEFAULT_VOLUME
  },
  setVolume: (v: number) => {
    markTouched()
    muted = false
    volume = Math.max(0, Math.min(1, Math.round(v * 10) / 10))
  },
  louder: () => {
    markTouched()
    muted = false
    volume = Math.min(1, Math.round((volume + VOLUME_STEP) * 10) / 10)
  },
  quieter: () => {
    markTouched()
    volume = Math.max(0, Math.round((volume - VOLUME_STEP) * 10) / 10)
  }
}

/**
 * Background music, clients only. One audio entity parented to the player (so it plays at a flat volume anywhere,
 * no spatial fade), same approach as the Marsh Colony jukebox: it starts at the real volume, and a clip is swapped
 * with createOrReplace (changing audioClipUrl on the live component is ignored by the renderer).
 * The lobby loop plays while waiting (lobby, winner); the arena loop from the 3-2-1 until the round
 * ends. Switching fades the current track out, swaps, and fades the new one in.
 */
export function setupMusic() {
  // Saved settings: the server sends them after our hello, and we send changes back once the player stops adjusting.
  const snapshot = () => ({ volume: Math.round(volume * 100), muted, sfxVolume: Math.round(sfxVolume * 100), sfxMuted })
  let saved = snapshot()
  let changedAt = 0
  room.onMessage('musicPrefs', (d) => {
    if (!d.found || userTouched) return
    volume = Math.max(0, Math.min(100, d.volume)) / 100
    muted = d.muted
    sfxVolume = Math.max(0, Math.min(100, d.sfxVolume)) / 100
    sfxMuted = d.sfxMuted
    saved = snapshot()
  })
  engine.addSystem(() => {
    const now = snapshot()
    if (JSON.stringify(now) === JSON.stringify(saved)) {
      changedAt = 0
      return
    }
    if (changedAt === 0) changedAt = Date.now()
    if (Date.now() - changedAt < SAVE_AFTER_MS || !isServerAlive()) return
    room.send('musicPrefs', { ...now, found: true })
    saved = now
    changedAt = 0
  })

  engine.addSystem(() => {
    if (isMobile() && inputSystem.isTriggered(SOUND_TOUCH_ACTION, PointerEventType.PET_DOWN)) soundPanel.toggle()
  })

  const entity = engine.addEntity()
  Transform.create(entity, { parent: engine.PlayerEntity, position: Vector3.Zero() })
  let current: string = LOBBY_MUSIC
  let gain = 1 // fade level of the current clip
  AudioSource.create(entity, { audioClipUrl: current, playing: !muted, loop: true, volume: outVolume(current, gain) })
  console.log('[CLIENT] music started (volume', Math.round(volume * 100) + '%)')

  engine.addSystem((dt: number) => {
    let phase: string = Phase.Lobby
    for (const [, s] of engine.getEntitiesWith(GameState)) phase = s.phase
    const fighting = phase === Phase.Starting || phase === Phase.Round || solo.active // a solo run gets the arena music too
    const wanted = fighting ? ARENA_MUSIC : LOBBY_MUSIC

    // into the arena track fast, so it is already playing as the 3-2-1 begins (that phase only lasts a few seconds)
    const step = (wanted === ARENA_MUSIC || current === ARENA_MUSIC ? ARENA_FADE_PER_SECOND : FADE_PER_SECOND) * dt
    if (wanted !== current) {
      gain = Math.max(0, gain - step) // fade the old clip out...
      if (gain <= 0.02) {
        current = wanted // ...swap the whole component, then fade in from near silence
        gain = 0.2
        AudioSource.createOrReplace(entity, { audioClipUrl: current, playing: !muted, loop: true, volume: outVolume(current, gain) })
        return
      }
    } else {
      gain = Math.min(1, gain + step)
    }

    const audio = AudioSource.getMutable(entity)
    const level = outVolume(current, gain)
    if (audio.playing !== !muted) audio.playing = !muted
    if (audio.volume !== level) audio.volume = level
  })
}
