import { engine, InputAction, InputModifier, Material, TouchScreenControls } from '@dcl/sdk/ecs'
import { BAT_ICON, Phase, PlayerStatus } from '../shared/config'
import { SOUND_MENU_ICON, SOUND_TOUCH_ACTION } from './music'
import { GameState, PlayerState } from '../shared/schemas'
import { getPlayer } from '@dcl/sdk/src/players'
import { solo } from './soloState'

type Mode = 'lobby' | 'combat'

const GAMEPAD_BUTTONS = [
  InputAction.IA_POINTER,
  InputAction.IA_PRIMARY,
  InputAction.IA_SECONDARY,
  InputAction.IA_JUMP,
  InputAction.IA_ACTION_3,
  InputAction.IA_ACTION_4,
  InputAction.IA_ACTION_5,
  InputAction.IA_ACTION_6
]

/** Combat = alive in a running round, or in a solo run. Everyone else (lobby, countdown, eliminated) is in lobby mode. */
export function inCombat(): boolean {
  if (solo.active) return true // a solo run is combat too (jump lock, bat button)
  const me = getPlayer()?.userId?.toLowerCase()
  if (!me) return false
  let roundRunning = false
  for (const [, s] of engine.getEntitiesWith(GameState)) roundRunning = s.phase === Phase.Round || s.phase === Phase.Starting
  if (!roundRunning) return false
  for (const [, p] of engine.getEntitiesWith(PlayerState)) if (p.playerId === me) return p.status === PlayerStatus.Alive
  return false
}

function applyLobby() {
  // Jump allowed. On touch screens: the big jump button, a small bat button (a fun swing), and one sound entry
  // (action 3) that the explorer keeps out of the way of the bat.
  InputModifier.deleteFrom(engine.PlayerEntity)
  TouchScreenControls.createOrReplace(engine.RootEntity, {
    mainAction: InputAction.IA_JUMP,
    touchInputs: GAMEPAD_BUTTONS.filter((a) => a !== InputAction.IA_JUMP).map((inputAction) => {
      if (inputAction === InputAction.IA_PRIMARY) {
        return { inputAction, hide: false, icon: Material.Texture.Common({ src: BAT_ICON }) }
      }
      if (inputAction === SOUND_TOUCH_ACTION) {
        return { inputAction, hide: false, icon: Material.Texture.Common({ src: SOUND_MENU_ICON }) }
      }
      return { inputAction, hide: true }
    }),
    hideJoystick: false,
    hideCrosshair: true
  })
}

function lockJump() {
  InputModifier.createOrReplace(engine.PlayerEntity, {
    mode: InputModifier.Mode.Standard({ disableJump: true, disableDoubleJump: true, disableGliding: true })
  })
}

function applyCombat() {
  // No jumping on any platform; on touch screens the big central button becomes the bat.
  lockJump()
  TouchScreenControls.createOrReplace(engine.RootEntity, {
    mainAction: InputAction.IA_PRIMARY,
    touchInputs: GAMEPAD_BUTTONS.map((inputAction) =>
      inputAction === InputAction.IA_PRIMARY
        ? { inputAction, hide: false, icon: Material.Texture.Common({ src: BAT_ICON }) }
        : { inputAction, hide: true }
    ),
    hideJoystick: false,
    hideCrosshair: true
  })
}

/** Switches jump lock and touch controls whenever the local player enters or leaves combat. */
export function setupControls() {
  let mode: Mode | undefined
  engine.addSystem(() => {
    const next: Mode = inCombat() ? 'combat' : 'lobby'
    // In combat the jump lock is re-applied if anything removed it (the explorer can clear it around a teleport)
    if (next === 'combat' && mode === 'combat' && !InputModifier.has(engine.PlayerEntity)) lockJump()
    if (next === mode) return
    mode = next
    if (next === 'combat') applyCombat()
    else applyLobby()
    console.log('[CLIENT] controls ->', next)
  })
}
