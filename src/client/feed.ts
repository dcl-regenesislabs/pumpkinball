import { FEED_TTL_MS } from '../shared/config'

export interface FeedEntry {
  kind: 'elim' | 'fall' | 'vampire'
  victimId: string
  killerId: string // '' = the pumpkin itself
  at: number
}

const MAX_ENTRIES = 6
let entries: FeedEntry[] = []

/** Match recap lines for the top-right feed. */
export const feed = {
  add(entry: FeedEntry) {
    entries = [entry, ...entries].slice(0, MAX_ENTRIES)
  },
  /** Newest first, expired lines dropped. */
  recent(): FeedEntry[] {
    const now = Date.now()
    entries = entries.filter((e) => now - e.at < FEED_TTL_MS)
    return entries
  }
}
