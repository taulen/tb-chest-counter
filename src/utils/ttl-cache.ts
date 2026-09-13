/**
 * Tiny in-process TTL cache. Values are recomputed lazily once stale.
 * Intended for cheap memoization of read-mostly aggregates (e.g. dashboard
 * headline stats) within a single process.
 */

interface Entry {
  value: unknown;
  expires: number;
}

const store = new Map<string, Entry>();

/**
 * Returns the cached value for `key` if it is still fresh; otherwise runs
 * `compute`, stores the result with a `ttlMs` lifetime, and returns it.
 */
export function cached<T>(key: string, ttlMs: number, compute: () => T): T {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expires > now) {
    return hit.value as T;
  }
  const value = compute();
  store.set(key, { value, expires: now + ttlMs });
  return value;
}

/** Deletes every cached entry whose key starts with `prefix`. */
export function invalidate(prefix: string): void {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      store.delete(key);
    }
  }
}
