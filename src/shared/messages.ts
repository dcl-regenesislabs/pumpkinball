import { Schemas } from '@dcl/sdk/ecs'
import { registerMessages } from '@dcl/sdk/network'

export const Messages = {
  // Client -> server: this player's display name, so the leaderboard can show it later even when they are offline.
  hello: Schemas.Map({ name: Schemas.String }),

  // Client -> server: this player's sound settings (music and effects volume 0-100, and mutes), saved on the server for next time.
  // Server -> client: the saved settings, sent after `hello` (found is false for a first visit).
  musicPrefs: Schemas.Map({
    volume: Schemas.Int,
    muted: Schemas.Boolean,
    sfxVolume: Schemas.Int,
    sfxMuted: Schemas.Boolean,
    found: Schemas.Boolean
  }),

  // Client -> server -> everyone: a lobby swing knocked a pumpkin dummy (entity id) away from the player (dx/dz = push direction).
  dummyHit: Schemas.Map({ id: Schemas.Int, dx: Schemas.Float, dz: Schemas.Float, from: Schemas.String }),

  // Server -> everyone: a player was teleported (effects at where they were and where they land).
  teleportFx: Schemas.Map({
    fx: Schemas.Float,
    fy: Schemas.Float,
    fz: Schemas.Float,
    tx: Schemas.Float,
    ty: Schemas.Float,
    tz: Schemas.Float
  }),

  // Client -> server: the player pressed parry. Carries no position; the server decides.
  parry: Schemas.Map({ seq: Schemas.Int }),

  // Client -> server: the pumpkin flight `seq` that targeted me ended. kind is 'parry' or 'hit'.
  // x/y/z is where the ball was (my chest), so the next flight starts exactly there.
  resolve: Schemas.Map({
    seq: Schemas.Int,
    kind: Schemas.String,
    x: Schemas.Float,
    y: Schemas.Float,
    z: Schemas.Float
  }),

  // Server -> everyone: that swing connected. Drives the hit flash.
  parryHit: Schemas.Map({ playerId: Schemas.String }),

  // Server -> client (to the reporter): was that resolve accepted? Mainly for debugging.
  resolveResult: Schemas.Map({ seq: Schemas.Int, ok: Schemas.Boolean, reason: Schemas.String }),

  // Server -> everyone: match recap. kind 'elim' (killerId may be '' = the pumpkin itself) or 'fall'.
  feed: Schemas.Map({
    kind: Schemas.String,
    victimId: Schemas.String,
    killerId: Schemas.String,
    // Where the victim was (the lava splash plays here, after the victim has already been teleported away)
    x: Schemas.Float,
    y: Schemas.Float,
    z: Schemas.Float
  }),

  // Server -> everyone: this player was hit by the pumpkin (for the splash effect).
  playerHit: Schemas.Map({ playerId: Schemas.String }),

  // Server -> client (to the victim): the pumpkin hit you.
  damaged: Schemas.Map({ hp: Schemas.Int }),

  // Client -> server: this player wants to start / end a solo run against the Vampire.
  // Server -> client (to the sender): soloAck, whether the start was accepted (not during your own round).
  soloStart: Schemas.Map({ seq: Schemas.Int }),
  soloEnd: Schemas.Map({ seq: Schemas.Int }),
  soloAck: Schemas.Map({ ok: Schemas.Boolean }),

  // Solo progress. Client -> server: this player just cleared level `cleared` (saved if it is a new best).
  // Server -> client: how many levels this player has cleared, sent after `hello`.
  soloProgress: Schemas.Map({ cleared: Schemas.Int }),

  // Server -> client (sent with { to: [address] }): move this player.
  teleport: Schemas.Map({
    x: Schemas.Float,
    y: Schemas.Float,
    z: Schemas.Float,
    lookX: Schemas.Float,
    lookY: Schemas.Float,
    lookZ: Schemas.Float
  })
}

export const room = registerMessages(Messages)
