import { AvatarMask } from '@dcl/sdk/ecs'
import { triggerSceneEmote } from '~system/RestrictedActions'
import {
  LOBBY_SWING_COOLDOWN_MS,
  PARRY_BUFFER_MS,
  PARRY_COOLDOWN_MS,
  PARRY_EMOTE_SRC,
  PARRY_PERFECT_LEAD_MS,
  PARRY_PERFECT_MS,
  PARRY_SWING_MS
} from '../shared/config'
import { room } from '../shared/messages'
import { inCombat } from './controls'
import { debug } from './debug'
import { swingAtDummies } from './dummy'
import { playSfx, SWING_SFX } from './sfx'
import { parryFeedback } from './feedback'
import { incoming } from './incoming'
import { solo } from './soloState'

let seq = 0
let startedAt = -Infinity // when the last press happened (swing window, debug)
let cooldownFrom = -Infinity // when the cooldown started; a successful parry resets it
let swingSpent = true // true = no unspent swing
let missPending = false
let lobbySwingAt = -Infinity
let buffered = false // a press made just before the cooldown ended
let swungOnce = false
let clickDownAt = 0 // a free-cursor left click still held: it may become a swing or a camera drag (0 = none)

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
  },
  /** How well this swing was timed for a pumpkin that reached you at `arrivedAt` (ms): pressed right on the perfect moment, or not. */
  grade(arrivedAt: number): 'perfect' | 'good' {
    const offset = startedAt - (arrivedAt - PARRY_PERFECT_LEAD_MS) // ms from the perfect moment, negative = early
    return Math.abs(offset) <= PARRY_PERFECT_MS ? 'perfect' : 'good'
  }
}

function press(at = Date.now()) {
  startedAt = at
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

/**
 * Used by the E key and the on-screen buttons. A real parry in a round; a fun swing in the lobby.
 * `at`: when the press really happened (a held click is only known to be a swing once released, see heldClick).
 */
export function requestParry(at = Date.now()) {
  swungOnce = true
  if (!inCombat()) return lobbySwing()
  if (at - cooldownFrom >= PARRY_COOLDOWN_MS) return press(at)

  // Cooldown still running: remember a press made right before it ends, drop the rest.
  const left = PARRY_COOLDOWN_MS - (at - cooldownFrom)
  buffered = left <= PARRY_BUFFER_MS
  debug.press = buffered ? `press: buffered (${Math.round(left)}ms left)` : `press: IGNORED, cooldown ${Math.round(left)}ms left`
}

/**
 * A left click with a free cursor. Holding it and dragging turns the camera, so it only becomes a swing once released without the
 * camera turning (setup.ts watches it). The swing is dated back to the press, and the pumpkin's referee waits for a click held at
 * contact before calling a hit, so timing a parry with a click works the same as with E, however long the button was down.
 */
export const heldClick = {
  down() {
    clickDownAt = Date.now()
  },
  /** It was a camera drag (or held too long): no swing. */
  cancel() {
    clickDownAt = 0
  },
  /** Released as a click: swing, counted from the press. */
  release() {
    if (!clickDownAt) return
    const at = clickDownAt
    clickDownAt = 0
    requestParry(at)
  },
  /** ms the click has been held; undefined when there is none. */
  heldMs: () => (clickDownAt ? Date.now() - clickDownAt : undefined),
  /** A held click that went down by `deadline` (ms) could still become a swing in time: the referee waits for it. */
  mightSwingBy: (deadline: number) => clickDownAt > 0 && clickDownAt <= deadline
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
    const eta = incoming.eta()
    parryFeedback.notice(eta !== undefined && eta > 0 ? 'Too early!' : 'Missed') // the pumpkin is still on its way: wait for the ring
  }
}
