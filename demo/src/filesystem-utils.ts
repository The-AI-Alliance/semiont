/**
 * Filesystem Path Utilities
 *
 * Helper functions for computing filesystem paths in the Semiont storage layers.
 * These utilities are for debugging/educational purposes only - production code
 * should use API endpoints exclusively.
 *
 * Storage Architecture:
 * - Layer 1: Raw document content (.dat files)
 * - Layer 2: Append-only event logs (.jsonl files)
 * - Layer 3: Consolidated projections with annotations (.json files)
 *
 * All layers use consistent hashing for sharding (65536 buckets = 4 hex digits).
 */

/**
 * Hash string to 32-bit unsigned integer
 * Matches backend's implementation in shard-utils.ts
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
 * Get shard path for a key using consistent hashing
 * Returns [shard1, shard2] where each is a 2-character hex string
 *
 * Example:
 * - Input: "doc-sha256:abc123..."
 * - Hash: 123456 (decimal)
 * - Shard ID: 123456 % 65536 = 57920
 * - Hex: "e240"
 * - Output: ["e2", "40"]
 *
 * Matches backend's getShardPath() in shard-utils.ts
 */
export function getShardPath(key: string, numBuckets: number = 65536): [string, string] {
  const hash = hashToUint32(key);
  const shardId = hash % numBuckets;
  const shardHex = shardId.toString(16).padStart(4, '0');
  const ab = shardHex.substring(0, 2);
  const cd = shardHex.substring(2, 4);
  return [ab, cd];
}

/**
 * Get Layer 1 path: Raw document content
 *
 * Format: {dataDir}/documents/{shard1}/{shard2}/{docId}.dat
 *
 * Layer 1 stores the raw content-addressed document files.
 * File extension is .dat (not .txt) and content is stored as-is.
 */
export function getLayer1Path(docId: string, dataDir: string): string {
  const [shard1, shard2] = getShardPath(docId);
  return `${dataDir}/documents/${shard1}/${shard2}/${docId}.dat`;
}

/**
 * Get Layer 2 path: Event log directory for a document
 *
 * Format: {dataDir}/events/shards/{shard1}/{shard2}/documents/{docId}/
 *
 * Layer 2 contains the append-only event log showing how the document
 * and its annotations evolved over time. Events are stored in .jsonl files.
 */
export function getLayer2Path(docId: string, dataDir: string): string {
  const [shard1, shard2] = getShardPath(docId);
  return `${dataDir}/events/shards/${shard1}/${shard2}/documents/${docId}`;
}

/**
 * Get Layer 3 path: Consolidated projection with annotations
 *
 * Format: {dataDir}/annotations/{shard1}/{shard2}/{docId}.json
 *
 * Layer 3 contains the current state projection - a consolidated view
 * of all annotations for a document. This is what the API endpoints
 * read when serving annotation queries. Updated synchronously when
 * events are written to Layer 2.
 */
export function getLayer3Path(docId: string, dataDir: string): string {
  const [shard1, shard2] = getShardPath(docId);
  return `${dataDir}/annotations/${shard1}/${shard2}/${docId}.json`;
}

/**
 * Get all layer paths for a document
 * Useful for debugging and showing the complete storage structure
 */
export interface LayerPaths {
  layer1: string; // Raw content
  layer2: string; // Event log
  layer3: string; // Projection
}

export function getAllLayerPaths(docId: string, dataDir: string): LayerPaths {
  return {
    layer1: getLayer1Path(docId, dataDir),
    layer2: getLayer2Path(docId, dataDir),
    layer3: getLayer3Path(docId, dataDir),
  };
}
