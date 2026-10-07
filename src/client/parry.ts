import { AvatarMask } from '@dcl/sdk/ecs'
import { triggerSceneEmote } from '~system/RestrictedActions'
import { LOBBY_SWING_COOLDOWN_MS, PARRY_BUFFER_MS, PARRY_COOLDOWN_MS, PARRY_EMOTE_SRC, PARRY_SWING_MS } from '../shared/config'
import { room } from '../shared/messages'
import { inCombat } from './controls'
import { debug } from './debug'
import { swingAtDummies } from './dummy'
import { playSfx, SWING_SFX } from './sfx'
import { parryFeedback } from './feedback'
import { solo } from './soloState'

let seq = 0
let startedAt = -Infinity // when the last press happened (swing window, debug)
let cooldownFrom = -Infinity // when the cooldown started; a successful parry resets it
let swingSpent = true // true = no unspent swing
let missPending = false
let lobbySwingAt = -Infinity
let buffered = false // a press made just before the cooldown ended
let swungOnce = false

/** True once the player has swung the bat this session: the "how to swing" tips stop showing. */
export const hasSwung = () => swungOnce

/** Milliseconds since the last accepted press (for the debug line). */
export const sinceLastPress = () => Date.now() - startedAt

/** Client-side mirror of the server cooldown, for the button and to avoid sending doomed presses. */
export const parryCooldown = {
  ready: () => Date.now() - cooldownFrom >= PARRY_COOLDOWN_MS,
  /** 0 = just used, 1 = ready. */
  fraction: () => Math.min(1, (Date.now() - cooldownFrom) / PARRY_COOLDOWN_MS)
}

/** The swing started by the last press: 'live' for a short moment, and it can parry only once. */
export const swing = {
  live: () => !swingSpent && Date.now() - startedAt <= PARRY_SWING_MS,
  /** The swing connected: it's spent, and the cooldown is refunded (only whiffs are punished). */
  consume() {
    swingSpent = true
    missPending = false
    cooldownFrom = -Infinity
  }
}

function press() {
  startedAt = Date.now()
  cooldownFrom = startedAt
  swingSpent = false
  missPending = true
  buffered = false
  debug.press = 'press: sent'
  if (!solo.active) room.send('parry', { seq: seq++ }) // a solo swing is judged on this client only
  playSwingEmote()
}

/** Plays the swing right away (no server round trip). Emotes sync to everyone by themselves.
 *  Upper-body mask: the swing plays without stopping the player from moving. */
function playSwingEmote() {
  playSfx(SWING_SFX)
  void triggerSceneEmote({ src: PARRY_EMOTE_SRC, loop: false, mask: AvatarMask.AM_UPPER_BODY }).catch(() => {})
}

/** In the lobby the swing is just for fun: no server message, no parry, only a small cooldown. */
function lobbySwing() {
  if (Date.now() - lobbySwingAt < LOBBY_SWING_COOLDOWN_MS) return
  lobbySwingAt = Date.now()
  playSwingEmote()
  swingAtDummies()
}

/** Used by the E key and the on-screen buttons. A real parry in a round; a fun swing in the lobby. */
export function requestParry() {
  swungOnce = true
  if (!inCombat()) return lobbySwing()
  if (parryCooldown.ready()) return press()

  // Cooldown still running: remember a press made right before it ends, drop the rest.
  const left = PARRY_COOLDOWN_MS - (Date.now() - cooldownFrom)
  buffered = left <= PARRY_BUFFER_MS
  debug.press = buffered ? `press: buffered (${Math.round(left)}ms left)` : `press: IGNORED, cooldown ${Math.round(left)}ms left`
}

/** Call every frame: tells the player when a swing expired without connecting. */
export function updateParryFeedback() {
  if (buffered && parryCooldown.ready()) {
    if (inCombat()) press()
    else buffered = false
  }
  if (missPending && Date.now() - startedAt > PARRY_SWING_MS) {
    missPending = false
    swingSpent = true
    parryFeedback.notice('Missed')
  }
}
