/** Fixed-window rate limiting backed by Postgres, so it holds across server instances. */
import 'server-only'
import { lt, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { appRateLimits } from '@/lib/db/schema'

export interface RateLimitResult {
  ok: boolean
  remaining: number
  retryAfterSeconds: number
}

export async function rateLimit(db: Db, key: string, limit: number, windowSeconds: number, now = new Date()): Promise<RateLimitResult> {
  const windowMs = windowSeconds * 1000
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs)
  const [row] = await db
    .insert(appRateLimits)
    .values({ key, windowStart, count: 1 })
    .onConflictDoUpdate({ target: [appRateLimits.key, appRateLimits.windowStart], set: { count: sql`${appRateLimits.count} + 1` } })
    .returning({ count: appRateLimits.count })
  const count = row?.count ?? limit + 1
  // Opportunistic cleanup of old windows; cheap and bounded by the index.
  if (count === 1 && Math.random() < 0.05) await db.delete(appRateLimits).where(lt(appRateLimits.windowStart, new Date(now.getTime() - 24 * 3_600_000)))
  return { ok: count <= limit, remaining: Math.max(0, limit - count), retryAfterSeconds: Math.ceil((windowStart.getTime() + windowMs - now.getTime()) / 1000) }
}
