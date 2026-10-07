import { AvatarModifierArea, AvatarModifierType, engine, Entity, Transform } from '@dcl/sdk/ecs'
import { getPlayer } from '@dcl/sdk/src/players'
import { PlayerStatus, SOLO_RING_AREA } from '../shared/config'
import { PlayerState } from '../shared/schemas'
import { findAvatar } from './avatars'

/**
 * Who this client may see inside the ring. One AvatarModifierArea covers the ring and hides every avatar in it except the
 * addresses in `excludeIds`. The area exists only on this client, so it changes what *I* see, never what others see; each
 * client builds its own list from the synced player statuses:
 *
 *   me playing solo      -> only me
 *   me in a match        -> the players in the match
 *   me watching (outside)-> the players in the running match, or if there is none, the solo players
 *
 * Standing outside the box, a viewer is never hidden by it; the box only decides which of the people inside they see.
 */

let area: Entity | undefined
let appliedKey = ''
let visible = new Set<string>()
let soloists = new Set<string>()
const FLOOR_TOLERANCE = 1.5 // an avatar standing on the ring can read a little below its surface: still in the ring

function myId(): string | undefined {
  return getPlayer()?.userId?.toLowerCase()
}

/** True when this avatar is inside the ring box (the only place the hiding applies). */
function inRing(id: string): boolean {
  const entity = findAvatar(id, myId())
  const t = entity !== undefined ? Transform.getOrNull(entity) : undefined
  if (!t) return false
  const { center, size } = SOLO_RING_AREA
  return Math.abs(t.position.x - center.x) <= size.x / 2 && t.position.y >= center.y - size.y / 2 - FLOOR_TOLERANCE && t.position.y <= center.y + size.y / 2 && Math.abs(t.position.z - center.z) <= size.z / 2
}

/**
 * True for an avatar that is in the ring but that this client has been told to hide (its bat must hide too). Someone in a solo
 * run counts as in the ring whatever their position reads (a jump, a fall, a lagging position): their bat is never shown to
 * anyone who cannot see them.
 */
export function isHiddenFromMe(id: string): boolean {
  if (!area || visible.has(id)) return false
  return soloists.has(id) || inRing(id)
}

function visibleSet(me: string): Set<string> {
  const alive: string[] = []
  const solos: string[] = []
  let myStatus: string = PlayerStatus.Idle
  for (const [, p] of engine.getEntitiesWith(PlayerState)) {
    if (p.status === PlayerStatus.Alive) alive.push(p.playerId)
    else if (p.status === PlayerStatus.Solo) solos.push(p.playerId)
    if (p.playerId === me) myStatus = p.status
  }
  soloists = new Set(solos)
  const out = new Set<string>([me])
  if (myStatus === PlayerStatus.Solo) return out
  for (const id of alive.length > 0 ? alive : solos) out.add(id)
  return out
}

export function setupSoloVisibility() {
  engine.addSystem(() => {
    const me = myId()
    // Player identity can arrive a few frames late. An area without the local player in its list would hide yourself too.
    if (!me) return

    visible = visibleSet(me)
    const ids = [...visible].sort()
    const key = ids.join(',')
    if (key === appliedKey && area) return
    appliedKey = key

    if (!area) {
      area = engine.addEntity()
      Transform.create(area, { position: SOLO_RING_AREA.center })
    }
    AvatarModifierArea.createOrReplace(area, {
      area: SOLO_RING_AREA.size,
      modifiers: [AvatarModifierType.AMT_HIDE_AVATARS, AvatarModifierType.AMT_HIDE_NAMETAGS],
      excludeIds: ids
    })
  })
}
