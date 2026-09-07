/**
 * Sharding Utilities
 *
 * Shared utilities for consistent sharding across all storage layers —
 * the event log and view storage (@semiont/event-sourcing) and the
 * anchored-text store (@semiont/content) all lay files out as
 * `{ab}/{cd}/<key>` through `getShardPath`. Hoisted here (PERSIST-ANCHORS
 * P1a) so both importers share one implementation: a second sharding
 * implementation is how two trees end up disagreeing about where
 * something lives.
 *
 * Pure string/number math — no node dependencies — so it is safe on
 * core's browser-facing root export.
 */
/**
 * TEMPORARY: Simple modulo-based hash sharding
 *
 * ⚠️ TODO: Replace with proper Jump Consistent Hash implementation
 *
 * This is a TEMPORARY implementation using simple modulo. It works and provides
 * good distribution, but does NOT provide the minimal reshuffling property of
 * Jump Consistent Hash when changing bucket counts.
 *
 * The proper implementation should use Google's Jump Consistent Hash algorithm:
 * Reference: "A Fast, Minimal Memory, Consistent Hash Algorithm" by Lamping & Veach (2014)
 * https://arxiv.org/abs/1406.2294
 *
 * Working implementations exist in npm packages like:
 * - jumphash (https://www.npmjs.com/package/jumphash)
 * - jump-gouache (https://github.com/bhoudu/jump-gouache)
 *
 * The algorithm requires proper 64-bit integer handling with BigInt to avoid
 * precision loss in JavaScript. The previous attempt failed due to incorrect
 * BigInt arithmetic in the while loop condition.
 *
 * Until replaced, this modulo approach will cause ALL data to be reshuffled
 * if bucket count changes, rather than the optimal O(n/k) reshuffling that
 * Jump Consistent Hash provides.
 *
 * @param key - The key to hash (a resource id or content checksum)
 * @param numBuckets - Number of shards/buckets (default: 65536 for 4-hex sharding)
 * @returns Shard number (0 to numBuckets-1)
 */
export declare function jumpConsistentHash(key: string, numBuckets?: number): number;
/**
 * Get 4-hex shard path for a key
 *
 * @param key - The key to hash (a resource id or content checksum)
 * @param numBuckets - Number of shards (default: 65536)
 * @returns Path segments like ['ab', 'cd']
 */
export declare function getShardPath(key: string, numBuckets?: number): [string, string];
