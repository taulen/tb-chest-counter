"use strict";
/**
 * Tiny in-process TTL cache. Values are recomputed lazily once stale.
 * Intended for cheap memoization of read-mostly aggregates (e.g. dashboard
 * headline stats) within a single process.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.cached = cached;
exports.invalidate = invalidate;
const store = new Map();
/**
 * Returns the cached value for `key` if it is still fresh; otherwise runs
 * `compute`, stores the result with a `ttlMs` lifetime, and returns it.
 */
function cached(key, ttlMs, compute) {
    const now = Date.now();
    const hit = store.get(key);
    if (hit && hit.expires > now) {
        return hit.value;
    }
    const value = compute();
    store.set(key, { value, expires: now + ttlMs });
    return value;
}
/** Deletes every cached entry whose key starts with `prefix`. */
function invalidate(prefix) {
    for (const key of store.keys()) {
        if (key.startsWith(prefix)) {
            store.delete(key);
        }
    }
}
//# sourceMappingURL=ttl-cache.js.map