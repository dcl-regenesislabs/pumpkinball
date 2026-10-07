import { engine, Entity, PlayerIdentityData, Transform } from '@dcl/sdk/ecs'
import { EntityNames } from '../../assets/scene/entity-names'
import { Vector3 } from '@dcl/sdk/math'
import { syncEntity } from '@dcl/sdk/network'
import {
  ARENA_CENTER,
  ARENA_SPAWN_RADIUS,
  COUNTDOWN_SECONDS,
  FALL_GRACE_MS,
  JOIN_PAD_RADIUS,
  JOIN_PAD_LEAVE_GRACE_MS,
  JOIN_PAD_LEAVE_RADIUS,
  LAVA_KILL_Y,
  FALL_NET_DEPTH,
  FALL_NET_RANGE,
  ARENA_FLOOR_Y,
  ARENA_RADIUS,
  MAX_HP,
  LOBBY_CENTER,
  LOBBY_MIN_Y,
  LOBBY_VAMPIRE_SPOT,
  VAMPIRE_LOBBY_POS,
  VAMPIRE_TALK_DISTANCE,
  LOBBY_SPAWN,
  sceneSpawnPoint,
  MIN_PLAYERS,
  PARRY_COOLDOWN_MS,
  Phase,
  PlayerStatus,
  ROUND_FAILSAFE_SECONDS,
  STARTING_SECONDS,
  SERVER_COOLDOWN_TOLERANCE,
  SERVER_SWING_VALID_MS,
  SOLO_BOSS_POS,
  SOLO_SPAWN,
  SPECTATOR_SPOT,
  WINNER_SECONDS
} from '../shared/config'
import { isOnLava } from '../shared/lava'

import { room } from '../shared/messages'
import { initLeaderboard, recordWin, setName } from './leaderboard'
import { loadMusicPrefs, saveMusicPrefs } from './musicPrefs'
import { createArenaHazards } from './hazards'
import { createPumpkin } from './pumpkin'
import { loadSoloProgress, saveSoloProgress } from './soloProgress'
import { GameState, PlayerState, ServerHeartbeat } from '../shared/schemas'

type Status = (typeof PlayerStatus)[keyof typeof PlayerStatus]
type Phase = (typeof Phase)[keyof typeof Phase]

interface Player {
  entity: Entity
  status: Status
  hp: number
}

const HEARTBEAT_MS = 2000

const players = new Map<string, Player>()
let stateEntity: Entity
let heartbeatEntity: Entity
let lastHeartbeat = 0

let phase: Phase = Phase.Lobby
let timer = 0
let round = 0
let roundStartedWith = 0
let winnerId = ''
let winnerPos = Vector3.Zero()
let roundStartedAt = 0
let pumpkin: ReturnType<typeof createPumpkin>
let hazards: ReturnType<typeof createArenaHazards>
const HAZARD_GRACE_MS = 900 // after a hazard hurts someone, hazards leave them alone this long
const lastHazardHit = new Map<string, number>()
const SOLO_BOSS_LOOK = SOLO_BOSS_POS
let lastPositions = new Map<string, Vector3>()
const lastParryAt = new Map<string, number>()
// The press each player last spent on a parry claim, so one press can't parry twice.
const consumedSwing = new Map<string, number>()
const lastTeleportAt = new Map<string, number>() // when each player was last sent somewhere (stray check waits for it to land)
const STRAY_GRACE_MS = 4000 // after any teleport, leave the player alone this long
const STRAY_CONFIRM_MS = 300 // must stay below lobby level this long (a blip never teleports anyone)
const strayFirstSeen = new Map<string, number>()
// When each player was last seen on the join pad (for the leave grace period).
const padLastSeen = new Map<string, number>()

export function initServer() {
  pumpkin = createPumpkin({ getAlive: getAlivePlayers, onHit: (address) => hitPlayer(address) })
  hazards = createArenaHazards({ getAlive: getAlivePlayers, hit: hazardHit })
  stateEntity = engine.addEntity()
  GameState.create(stateEntity, { phase, secondsLeft: 0, round: 0, queued: 0, alive: 0, winnerId: '', winnerX: 0, winnerY: 0, winnerZ: 0 })
  syncEntity(stateEntity, [GameState.componentId], 1)

  heartbeatEntity = engine.addEntity()
  ServerHeartbeat.create(heartbeatEntity, { at: Date.now() })
  syncEntity(heartbeatEntity, [ServerHeartbeat.componentId], 2)
  lastHeartbeat = Date.now()

  // A press: the server records it (cooldown + proof for a later parry claim). The swing animation plays locally.
  room.onMessage('parry', (_data, context) => {
    if (!context || phase !== Phase.Round) return
    const address = context.from.toLowerCase()
    const player = players.get(address)
    if (!player || player.status !== PlayerStatus.Alive) return

    const now = Date.now()
    const last = lastParryAt.get(address)
    const lastPressSucceeded = last !== undefined && consumedSwing.get(address) === last // a successful parry refunds the cooldown
    if (!lastPressSucceeded && now - (last ?? 0) < PARRY_COOLDOWN_MS * SERVER_COOLDOWN_TOLERANCE) return
    lastParryAt.set(address, now)
  })

  // The target's client reports how its pumpkin flight ended. The server validates and continues the rally.
  room.onMessage('resolve', (data, context) => {
    if (!context || phase !== Phase.Round) return
    const address = context.from.toLowerCase()
    const player = players.get(address)
    if (!player || player.status !== PlayerStatus.Alive) return
    if (data.kind !== 'parry' && data.kind !== 'hit') return

    const pressAt = lastParryAt.get(address)
    if (data.kind === 'parry') {
      // A parry claim needs a recent, unspent press (which already passed the cooldown check).
      if (pressAt === undefined || Date.now() - pressAt > SERVER_SWING_VALID_MS || consumedSwing.get(address) === pressAt) {
        room.send('resolveResult', { seq: data.seq, ok: false, reason: 'noPress' }, { to: [address] })
        return
      }
    }

    const result = pumpkin.resolve(address, data.seq, data.kind, Vector3.create(data.x, data.y, data.z))
    room.send('resolveResult', { seq: data.seq, ok: result === 'ok', reason: result }, { to: [address] })
    if (result !== 'ok') {
      console.log(`[SERVER] rejected ${data.kind} from ${address} (seq ${data.seq}): ${result}`)
      return
    }
    if (data.kind === 'parry') {
      consumedSwing.set(address, pressAt as number)
      room.send('parryHit', { playerId: address })
    }
  })

  // Solo run against the Vampire: the game itself is local to that client. The server only marks the player 'solo' (synced,
  // so every client can decide who to hide in the ring), moves them in and out, and leaves them alone otherwise.
  room.onMessage('soloStart', (data, context) => {
    if (!context) return
    const address = context.from.toLowerCase()
    console.log(`[SERVER] soloStart from ${context.from} (seq ${data.seq})`)
    const player = players.get(address)
    // Starting again while still marked 'solo' (stale from an earlier session that closed mid-run) is fine: it just restarts.
    const allowed =
      player &&
      (player.status === PlayerStatus.Idle || player.status === PlayerStatus.Queued || player.status === PlayerStatus.Out || player.status === PlayerStatus.Solo)
    if (!player || !allowed) {
      room.send('soloAck', { ok: false }, { to: [address] })
      return
    }
    padLastSeen.delete(address)
    setStatus(address, player, PlayerStatus.Solo)
    // seq 1 = the client is already in a run and only asks to be marked 'solo' again (no teleport, no answer needed)
    if (data.seq === 1) return
    teleport(address, SOLO_SPAWN, SOLO_BOSS_LOOK, false)
    room.send('soloAck', { ok: true }, { to: [address] })
    console.log(`[SERVER] ${address} started a solo run`)
  })
  room.onMessage('soloProgress', (data, context) => {
    if (context) saveSoloProgress(context.from.toLowerCase(), data.cleared)
  })
  room.onMessage('soloEnd', (data, context) => {
    if (!context) return
    const address = context.from.toLowerCase()
    const player = players.get(address)
    if (!player || player.status !== PlayerStatus.Solo) return
    setStatus(address, player, PlayerStatus.Idle)
    // seq 1: they beat the whole run, so they come back standing by the Vampire (who talks to them)
    if (data.seq === 1) {
      const talk = vampireTalkSpot()
      teleport(address, talk.spot, talk.lookAt, false)
    }
    else teleport(address, LOBBY_SPAWN, LOBBY_CENTER, false)
    console.log(`[SERVER] ${address} left the solo run`)
  })

  initLeaderboard()
  room.onMessage('hello', (data, context) => {
    if (!context) return
    const address = context.from.toLowerCase()
    setName(address, data.name)
    // A client that just connected cannot be in a solo run (the run lives in the client): clear any stale 'solo' status
    const hello = players.get(address)
    if (hello && hello.status === PlayerStatus.Solo) setStatus(address, hello, PlayerStatus.Idle)
    void loadSoloProgress(address).then((cleared) => room.send('soloProgress', { cleared }, { to: [address] }))
    void loadMusicPrefs(address).then((prefs) => {
      room.send(
        'musicPrefs',
        {
          volume: prefs?.volume ?? 0,
          muted: prefs?.muted ?? false,
          sfxVolume: prefs?.sfxVolume ?? 60,
          sfxMuted: prefs?.sfxMuted ?? false,
          found: !!prefs
        },
        { to: [address] }
      )
    })
  })
  // Lobby pumpkin dummy knocked: relay to everyone so all players see it swing (cosmetic only, lightly rate limited)
  const lastDummyHit = new Map<string, number>()
  room.onMessage('dummyHit', (data, context) => {
    if (!context) return
    const address = context.from.toLowerCase()
    const now = Date.now()
    if (now - (lastDummyHit.get(address) ?? 0) < 250) return
    if (!Number.isFinite(data.dx) || !Number.isFinite(data.dz) || Math.hypot(data.dx, data.dz) > 1.1) return
    lastDummyHit.set(address, now)
    room.send('dummyHit', { id: data.id, dx: data.dx, dz: data.dz, from: address })
  })
  room.onMessage('musicPrefs', (data, context) => {
    if (context) saveMusicPrefs(context.from.toLowerCase(), data)
  })

  engine.addSystem(gameSystem)
  console.log('[SERVER] initialised')
}

// ---- Public hooks for later milestones (pumpkin/parry) ----

export function getAlivePlayers(): string[] {
  return [...players.entries()].filter(([, p]) => p.status === PlayerStatus.Alive).map(([a]) => a)
}

/** The Vampire's floor attacks and fire rings: one heart, with a short grace so overlapping hazards cannot chain-kill. */
function hazardHit(address: string) {
  const now = Date.now()
  if (now - (lastHazardHit.get(address) ?? 0) < HAZARD_GRACE_MS) return
  if (players.get(address)?.status !== PlayerStatus.Alive) return
  lastHazardHit.set(address, now)
  hitPlayer(address, 'vampire')
}

/** Costs one HP; the player is eliminated at zero. */
function hitPlayer(address: string, cause: 'hp' | 'vampire' = 'hp') {
  const p = players.get(address)
  if (!p || p.status !== PlayerStatus.Alive) return
  setHp(p, p.hp - 1)
  room.send('damaged', { hp: p.hp, hazard: cause === 'vampire' }, { to: [address] })
  room.send('playerHit', { playerId: address })
  console.log(`[SERVER] ${address} hit, ${p.hp} HP left`)
  if (p.hp <= 0) eliminate(address, cause)
}

function setHp(p: Player, hp: number) {
  p.hp = Math.max(0, hp)
  const state = PlayerState.getMutableOrNull(p.entity)
  if (state) state.hp = p.hp
}

export function eliminate(address: string, reason: 'hp' | 'fell' | 'vampire' = 'hp', at?: Vector3) {
  const p = players.get(address)
  if (!p || p.status !== PlayerStatus.Alive) return
  // Someone must win: if the last other player went out in this same tick, this one stays in (and wins when the tick ends)
  if (phase === Phase.Round && roundStartedWith >= 2 && getAlivePlayers().length === 1) {
    setHp(p, Math.max(1, p.hp))
    if (reason === 'fell') teleport(address, Vector3.create(ARENA_CENTER.x, ARENA_CENTER.y + 0.5, ARENA_CENTER.z), ARENA_CENTER)
    console.log(`[SERVER] ${address} would have fallen with the last other player: they win`)
    return
  }
  setHp(p, 0)
  setStatus(address, p, PlayerStatus.Out)
  at = at ?? lastPositions.get(address) // where they were, before the teleport (clients leave a blood splat there)
  teleport(address, SPECTATOR_SPOT, ARENA_CENTER)

  // Match recap for everyone. An 'hp' elimination credits whoever last parried the pumpkin.
  const parrier = reason === 'hp' ? pumpkin.lastParrier() : ''
  room.send('feed', {
    kind: reason === 'fell' ? 'fall' : reason === 'vampire' ? 'vampire' : 'elim',
    victimId: address,
    killerId: parrier && parrier !== address ? parrier : '',
    x: at?.x ?? 0,
    y: at?.y ?? 0,
    z: at?.z ?? 0
  })
  console.log(`[SERVER] eliminated ${address} (${reason})`)
}

/** Alive players touching the lava are out instantly. A depth check near the ring catches any gap before the lava. */
function checkLava(positions: Map<string, Vector3>) {
  if (Date.now() - roundStartedAt < FALL_GRACE_MS) return
  for (const address of getAlivePlayers()) {
    const pos = positions.get(address)
    if (!pos) continue
    const touchingLava = pos.y < LAVA_KILL_Y && isOnLava(pos.x, pos.z)
    const fellOffRing =
      pos.y < ARENA_FLOOR_Y - FALL_NET_DEPTH &&
      Math.hypot(pos.x - ARENA_CENTER.x, pos.z - ARENA_CENTER.z) <= ARENA_RADIUS + FALL_NET_RANGE
    if (touchingLava || fellOffRing) eliminate(address, 'fell', pos)
  }
}

export function isRoundActive() {
  return phase === Phase.Round
}

// ---- Main loop ----

function gameSystem(dt: number) {
  const positions = syncPlayers()
  lastPositions = positions
  heartbeat()
  rescueStrays(positions)

  switch (phase) {
    case Phase.Lobby:
      updateQueue(positions)
      if (countQueued() >= MIN_PLAYERS) {
        setPhase(Phase.Countdown, COUNTDOWN_SECONDS)
      }
      break

    case Phase.Countdown:
      updateQueue(positions)
      if (countQueued() < MIN_PLAYERS) {
        setPhase(Phase.Lobby, 0)
        break
      }
      timer -= dt
      if (timer <= 0) startRound()
      break

    case Phase.Starting:
      // Everyone is on the arena; the pumpkin is released when the 3-2-1 ends. The lava still counts.
      timer -= dt
      checkLava(positions)
      if (timer <= 0) beginRound()
      break

    case Phase.Round: {
      timer -= dt
      checkLava(positions)
      pumpkin.update(dt, positions)
      try {
        hazards.update(dt, positions)
      } catch (error) {
        console.log('[SERVER] hazards failed:', error) // a bug in the Vampire must never take the match (and the server) down
      }
      const alive = getAlivePlayers().length
      const decided = roundStartedWith >= 2 ? alive <= 1 : alive === 0
      if (decided || timer <= 0) endRound()
      break
    }

    case Phase.Winner:
      timer -= dt
      if (timer <= 0) resetToLobby()
      break
  }

  publish()
}

// ---- Player tracking ----

/** Reconciles the players map with who is in the scene; returns server-read positions. */
function syncPlayers(): Map<string, Vector3> {
  const positions = new Map<string, Vector3>()
  for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
    const t = Transform.getOrNull(entity)
    if (!t) continue
    const address = identity.address.toLowerCase()
    positions.set(address, t.position)
    if (!players.has(address)) {
      const e = engine.addEntity()
      PlayerState.create(e, { playerId: address, status: PlayerStatus.Idle, hp: 0 })
      syncEntity(e, [PlayerState.componentId])
      players.set(address, { entity: e, status: PlayerStatus.Idle, hp: 0 })
    }
  }

  for (const [address, p] of players) {
    if (positions.has(address)) continue
    if (p.status === PlayerStatus.Alive) setStatus(address, p, PlayerStatus.Out)
    engine.removeEntity(p.entity)
    players.delete(address)
    lastParryAt.delete(address)
    consumedSwing.delete(address)
    lastTeleportAt.delete(address)
    strayFirstSeen.delete(address)
    padLastSeen.delete(address)
  }
  return positions
}

function setStatus(address: string, p: Player, status: Status) {
  if (p.status === status) return
  p.status = status
  const state = PlayerState.getMutableOrNull(p.entity)
  if (state) state.status = status
  else console.log(`[SERVER] stale player entity for ${address}`)
}

/**
 * Players on the join pad are queued (lobby/countdown only). Joining is generous (pad radius plus a margin, any
 * jump height) and leaving is forgiving: you must be clearly off the pad for a moment, so nobody on it gets dropped.
 */
function updateQueue(positions: Map<string, Vector3>) {
  const now = Date.now()
  for (const [address, p] of players) {
    if (p.status === PlayerStatus.Solo) continue // in their own run: never queued, never un-queued
    const pos = positions.get(address)
    if (!pos) continue
    const dist = flatDistance(pos, LOBBY_CENTER)
    const nearHeight = Math.abs(pos.y - LOBBY_CENTER.y) < 6
    if (dist <= JOIN_PAD_RADIUS && nearHeight) {
      padLastSeen.set(address, now)
      setStatus(address, p, PlayerStatus.Queued)
    } else if (p.status === PlayerStatus.Queued && dist <= JOIN_PAD_LEAVE_RADIUS && nearHeight) {
      padLastSeen.set(address, now) // just outside the rim: still counts
    } else if (p.status === PlayerStatus.Queued && now - (padLastSeen.get(address) ?? 0) < JOIN_PAD_LEAVE_GRACE_MS) {
      // briefly out of range (jump, lag): stay queued
    } else {
      setStatus(address, p, PlayerStatus.Idle)
    }
  }
}

function countQueued() {
  let n = 0
  for (const p of players.values()) if (p.status === PlayerStatus.Queued) n++
  return n
}

// ---- Phase transitions ----

function setPhase(next: Phase, seconds: number) {
  phase = next
  timer = seconds
  console.log(`[SERVER] phase -> ${next}`)
}

function startRound() {
  const participants = [...players.entries()].filter(([, p]) => p.status === PlayerStatus.Queued)
  roundStartedWith = participants.length
  roundStartedAt = Date.now()
  winnerId = ''
  lastHazardHit.clear()
  round++
  participants.forEach(([address, p], i) => {
    setHp(p, MAX_HP)
    setStatus(address, p, PlayerStatus.Alive)
    const angle = (i / participants.length) * Math.PI * 2
    const spawn = Vector3.create(
      ARENA_CENTER.x + Math.cos(angle) * ARENA_SPAWN_RADIUS,
      ARENA_CENTER.y + 0.5,
      ARENA_CENTER.z + Math.sin(angle) * ARENA_SPAWN_RADIUS
    )
    teleport(address, spawn, ARENA_CENTER)
  })
  setPhase(Phase.Starting, STARTING_SECONDS)
}

/** The 3-2-1 is over: the round clock starts and the pumpkin is released. */
function beginRound() {
  setPhase(Phase.Round, ROUND_FAILSAFE_SECONDS)
  pumpkin.start()
  hazards.start()
}

function endRound() {
  const alive = getAlivePlayers()
  // Normally exactly one is left. If the failsafe ended a stalled round, the player with the most hearts wins it.
  const best = alive.slice().sort((a, b) => (players.get(b)?.hp ?? 0) - (players.get(a)?.hp ?? 0))[0]
  winnerId = roundStartedWith >= 2 && alive.length >= 1 ? best : ''
  pumpkin.stop()
  hazards.stop()
  winnerPos = (winnerId && lastPositions.get(winnerId)) || Vector3.Zero()
  if (winnerId) recordWin(winnerId) // only a real win counts: 2+ players started and exactly one is left
  setPhase(Phase.Winner, WINNER_SECONDS)
}

function resetToLobby() {
  for (const [address, p] of players) {
    if (p.status === PlayerStatus.Solo) continue // a solo run goes on through other players' matches
    if (p.status === PlayerStatus.Alive || p.status === PlayerStatus.Out) {
      teleport(address, LOBBY_SPAWN, LOBBY_CENTER)
    }
    setHp(p, 0)
    setStatus(address, p, PlayerStatus.Idle)
  }
  winnerId = ''
  winnerPos = Vector3.Zero()
  setPhase(Phase.Lobby, 0)
}

// ---- Helpers ----

/**
 * Safety net: anyone who is not in the game and is down on the arena floor, in the lava, on the ring or on the ground
 * (below the lobby level) goes back to the scene's spawn. Covers anything that carries a player off the balcony
 * (the flying decorative pumpkins, a bad jump, a glitch). Players in the round are left alone, and so is anyone who was
 * just teleported (spectators are sent to the arena edge on purpose, and the message needs a moment to land).
 */
function rescueStrays(positions: Map<string, Vector3>) {
  const now = Date.now()
  for (const [address, p] of players) {
    const pos = positions.get(address)
    // in the round, or up on the balcony: nothing to do (and forget any earlier sighting)
    if (p.status === PlayerStatus.Alive || p.status === PlayerStatus.Solo || !pos || pos.y >= LOBBY_MIN_Y) {
      strayFirstSeen.delete(address)
      continue
    }
    if (now - (lastTeleportAt.get(address) ?? 0) < STRAY_GRACE_MS) continue
    const since = strayFirstSeen.get(address)
    if (since === undefined) {
      strayFirstSeen.set(address, now)
      continue
    }
    if (now - since < STRAY_CONFIRM_MS) continue
    strayFirstSeen.delete(address)
    console.log(`[SERVER] stray ${address} at y=${pos.y.toFixed(1)}: back to spawn`)
    // landing back at the spawn must never leave them in the game queue
    if (p.status === PlayerStatus.Queued) setStatus(address, p, PlayerStatus.Idle)
    padLastSeen.delete(address)
    teleport(address, sceneSpawnPoint(), ARENA_CENTER)
  }
}

/** `fx` false = no sparkle for the other players (a solo player slipping in and out of the ring unseen). */
/**
 * Where a player stands to talk to the lobby Vampire: in front of him, wherever he is placed in the editor (his position and
 * the way he faces are read from the scene), so moving or turning him needs no code change. Falls back to the config spot.
 */
function vampireTalkSpot(): { spot: Vector3; lookAt: Vector3 } {
  const entity = engine.getEntityOrNullByName(EntityNames.Vampire_glb)
  const t = entity !== null ? Transform.getOrNull(entity) : null
  if (!t) return { spot: LOBBY_VAMPIRE_SPOT, lookAt: VAMPIRE_LOBBY_POS }
  const forward = Vector3.rotate(Vector3.Forward(), t.rotation)
  const len = Math.hypot(forward.x, forward.z) || 1
  const spot = Vector3.create(
    t.position.x + (forward.x / len) * VAMPIRE_TALK_DISTANCE,
    t.position.y + 0.65, // his feet are at the floor; players land a little above it
    t.position.z + (forward.z / len) * VAMPIRE_TALK_DISTANCE
  )
  return { spot, lookAt: Vector3.create(t.position.x, t.position.y, t.position.z) }
}

function teleport(address: string, to: Vector3, lookAt: Vector3, fx = true) {
  lastTeleportAt.set(address, Date.now())
  const from = lastPositions.get(address) ?? to
  if (fx) room.send('teleportFx', { fx: from.x, fy: from.y, fz: from.z, tx: to.x, ty: to.y, tz: to.z }) // everyone sees it
  room.send(
    'teleport',
    { x: to.x, y: to.y, z: to.z, lookX: lookAt.x, lookY: 1, lookZ: lookAt.z },
    { to: [address] }
  )
}

function flatDistance(a: Vector3, b: Vector3) {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

function heartbeat() {
  const now = Date.now()
  if (now - lastHeartbeat < HEARTBEAT_MS) return
  lastHeartbeat = now
  ServerHeartbeat.getMutable(heartbeatEntity).at = now
}

/** Writes GameState only when a field actually changed, to avoid resending every frame. */
function publish() {
  const s = GameState.getMutable(stateEntity)
  const secondsLeft = phase === Phase.Round ? 0 : Math.max(0, Math.ceil(timer)) // no countdown in a round: do not resend the state every second
  const queued = countQueued()
  const alive = getAlivePlayers().length
  if (
    s.phase !== phase ||
    s.secondsLeft !== secondsLeft ||
    s.round !== round ||
    s.queued !== queued ||
    s.alive !== alive ||
    s.winnerId !== winnerId ||
    s.winnerX !== winnerPos.x ||
    s.winnerY !== winnerPos.y ||
    s.winnerZ !== winnerPos.z
  ) {
    s.phase = phase
    s.secondsLeft = secondsLeft
    s.round = round
    s.queued = queued
    s.alive = alive
    s.winnerId = winnerId
    s.winnerX = winnerPos.x
    s.winnerY = winnerPos.y
    s.winnerZ = winnerPos.z
  }
}
