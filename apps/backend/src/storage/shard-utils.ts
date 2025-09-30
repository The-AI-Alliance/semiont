/**
 * Sharding Utilities
 *
 * Shared utilities for consistent sharding across all storage layers
 * Uses Google's Jump Consistent Hash algorithm for even distribution
 */

import { createHash } from 'crypto';

/**
 * Google's Jump Consistent Hash Algorithm
 *
 * Provides minimal disruption when changing shard counts with O(ln n) remapping.
 * Reference: "A Fast, Minimal Memory, Consistent Hash Algorithm" by Lamping & Veach (2014)
 * https://arxiv.org/abs/1406.2294
 *
 * @param key - The key to hash (typically a document ID)
 * @param numBuckets - Number of shards/buckets (default: 65536 for 4-hex sharding)
 * @returns Shard number (0 to numBuckets-1)
 */
export function jumpConsistentHash(key: string, numBuckets: number = 65536): number {
  let hash = hashToUint32(key);
  let b = -1;
  let j = 0;

  while (j < numBuckets) {
    b = j;
    hash = hash * 2862933555777941757 + 1;
    j = Math.floor((b + 1) * (Math.pow(2, 31) / ((hash >>> 1) + 1)));
  }

  return b;
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
 * @param key - The key to hash (typically a document ID)
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