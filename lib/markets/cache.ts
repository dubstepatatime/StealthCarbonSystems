/**
 * A small in-process cache with single-flight loading and stale-if-error.
 *
 * Each server instance keeps its own copy. That is deliberate: it needs no
 * shared infrastructure, and the worst case is one upstream call per instance
 * per TTL. A value that could not be refreshed is served stale for a bounded
 * time and reported as stale, never silently.
 */
interface Entry<T> {
  value?: T
  storedAt?: number
  inflight?: Promise<T>
}

const globalStore = globalThis as unknown as { __scCache?: Map<string, Entry<unknown>> }
const store: Map<string, Entry<unknown>> = (globalStore.__scCache ??= new Map())

export interface Cached<T> {
  value: T
  /** True when the loader failed and an older value was returned. */
  stale: boolean
  ageMs: number
}

export interface CacheOptions {
  ttlMs: number
  /** Serve an expired value for this long when the loader fails. Default: do not. */
  staleIfErrorMs?: number
  now?: () => number
}

export async function cached<T>(key: string, load: () => Promise<T>, { ttlMs, staleIfErrorMs = 0, now = Date.now }: CacheOptions): Promise<Cached<T>> {
  const entry = (store.get(key) ?? {}) as Entry<T>
  store.set(key, entry as Entry<unknown>)
  const age = entry.storedAt === undefined ? Number.POSITIVE_INFINITY : now() - entry.storedAt
  if (entry.value !== undefined && age < ttlMs) return { value: entry.value, stale: false, ageMs: age }

  if (!entry.inflight) {
    entry.inflight = load()
      .then((value) => {
        entry.value = value
        entry.storedAt = now()
        return value
      })
      .finally(() => {
        entry.inflight = undefined
      })
  }
  try {
    const value = await entry.inflight
    return { value, stale: false, ageMs: 0 }
  } catch (err) {
    if (entry.value !== undefined && age < ttlMs + staleIfErrorMs) return { value: entry.value, stale: true, ageMs: age }
    throw err
  }
}

/** Tests only. */
export function clearCache(): void {
  store.clear()
}
