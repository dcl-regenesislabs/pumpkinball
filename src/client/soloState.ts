import { MAX_HP } from '../shared/config'

export type SoloPhase = 'fight' | 'won' | 'lost'

/**
 * State of this client's own solo run. Plain data in its own module so controls, parry, UI and the fight can all read it
 * without importing each other. Nothing here is synced: only the server's 'solo' player status is shared.
 */
export const solo = {
  /** In a solo run (after the server accepted it, until the player leaves the ring). */
  active: false,
  /** The level intro camera is playing (the player is held still). */
  intro: false,
  /** The camera is on the last defeated boss (the winner image shows) before the end card. */
  victory: false,
  victoryAge: 0,
  victoryDur: 4.2,
  victoryId: 0,
  /** The whole run was cleared this session: leaving the ring brings you to a talk with the Vampire. */
  epilogue: false,
  /** Levels cleared so far (saved on the server). */
  cleared: 0,
  /** Level to begin at once the server accepts the start. */
  startAt: 1,
  introAge: 0,
  introDur: 1,
  /** Asked the server to start, waiting for its answer. */
  starting: false,
  phase: 'fight' as SoloPhase,
  level: 1,
  levelCount: 5,
  levelName: '',
  hp: MAX_HP,
  /** One health bar per boss in the current level. */
  bosses: [] as { name: string; hp: number; maxHp: number }[]
}

/** Things other modules register so solo.ts can reach them without importing them (that would be circular). */
export const hooks = {
  /** After beating the whole run and leaving the ring: open the Vampire's closing talk. */
  epilogue: () => {}
}

/** The conversation with the lobby Vampire. */
export type DialogMode = 'intro' | 'again' | 'epilogue'

export const vampireDialog = {
  open: false,
  line: 0,
  mode: 'intro' as DialogMode,
  variant: 0
}
