/**
 * Sharding Utilities
 *
 * Shared utilities for consistent sharding across all storage layers
 * Uses Google's Jump Consistent Hash algorithm for even distribution
 */

import { createHash } from 'crypto';

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
 * @param key - The key to hash (typically a resource ID)
 * @param numBuckets - Number of shards/buckets (default: 65536 for 4-hex sharding)
 * @returns Shard number (0 to numBuckets-1)
 */
export function jumpConsistentHash(key: string, numBuckets: number = 65536): number {
  const hash = hashToUint32(key);
  return hash % numBuckets;
}

/**
 * Hash string to 32-bit unsigned integer
 */
function hashToUint32(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & 0xFFFFFFFF;
  }
  return Math.abs(hash);
}

/**
 * Convert shard number to 4-hex directory path (ab/cd)
 *
 * @param shardId - Shard number (0-65535)
 * @returns Path segments like ['ab', 'cd']
 */
export function shardIdToPath(shardId: number): [string, string] {
  if (shardId < 0 || shardId >= 65536) {
    throw new Error(`Invalid shard ID: ${shardId}. Must be 0-65535 for 4-hex sharding.`);
  }

  const shardHex = shardId.toString(16).padStart(4, '0');
  const ab = shardHex.substring(0, 2);
  const cd = shardHex.substring(2, 4);

  return [ab, cd];
}

/**
 * Get 4-hex shard path for a key
 *
 * @param key - The key to hash (typically a resource ID)
 * @param numBuckets - Number of shards (default: 65536)
 * @returns Path segments like ['ab', 'cd']
 */
export function getShardPath(key: string, numBuckets: number = 65536): [string, string] {
  const shardId = jumpConsistentHash(key, numBuckets);
  return shardIdToPath(shardId);
}

/**
 * Calculate SHA-256 hash of data
 */
export function sha256(data: string | object): string {
  const content = typeof data === 'string' ? data : JSON.stringify(data);
  return createHash('sha256').update(content).digest('hex');
}