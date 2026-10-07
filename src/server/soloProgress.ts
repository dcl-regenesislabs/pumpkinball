import { Storage } from '@dcl/sdk/server'
import { LEVELS } from '../shared/soloLevels'

/**
 * How many solo levels each player has cleared, in the scene's player Storage so it comes back next visit. The client tells
 * the server when it clears a level; the value only ever goes up. (It is the client's word: a reward claim later should be
 * verified some other way.)
 */

const KEY = 'soloProgress'
const cache = new Map<string, number>()

const clamp = (n: unknown) => {
  const v = Math.round(Number(n))
  return Number.isFinite(v) ? Math.max(0, Math.min(LEVELS.length, v)) : 0
}

export async function loadSoloProgress(address: string): Promise<number> {
  const cached = cache.get(address)
  if (cached !== undefined) return cached
  try {
    const raw = await Storage.player.get<unknown>(address, KEY)
    const stored = typeof raw === 'string' ? JSON.parse(raw) : raw
    const cleared = clamp(typeof stored === 'object' && stored ? (stored as { cleared?: number }).cleared : stored)
    cache.set(address, cleared)
    return cleared
  } catch (error) {
    console.log('[SERVER] solo progress load failed:', error)
    return 0
  }
}

export function saveSoloProgress(address: string, cleared: number) {
  const next = clamp(cleared)
  if (next <= (cache.get(address) ?? 0)) return
  cache.set(address, next)
  void Storage.player.set(address, KEY, JSON.stringify({ cleared: next })).then((ok) => {
    if (!ok) console.log('[SERVER] solo progress save failed for', address)
  })
}
