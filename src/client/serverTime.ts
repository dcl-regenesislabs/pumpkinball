import { engine } from '@dcl/sdk/ecs'
import { ServerHeartbeat } from '../shared/schemas'

/**
 * The server's clock, as this client can best tell. Every heartbeat carries the server's time; the gap between it and the local
 * clock is the clock difference plus the delay in getting here, so the delay only ever makes the gap smaller. The largest gap
 * seen is the closest estimate (and a stale first value is simply beaten by the next one).
 */
let offset: number | undefined
let lastAt = 0

export function updateServerTime() {
  for (const [, h] of engine.getEntitiesWith(ServerHeartbeat)) {
    if (h.at === lastAt) continue
    lastAt = h.at
    const sample = h.at - Date.now()
    offset = offset === undefined ? sample : Math.max(offset, sample)
  }
}

export const hasServerTime = () => offset !== undefined
export const serverNow = () => Date.now() + (offset ?? 0)
