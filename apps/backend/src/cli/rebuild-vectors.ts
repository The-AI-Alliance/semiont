#!/usr/bin/env node
/**
 * CLI Tool: Rebuild Vector Store
 *
 * The Smelter now runs as an external actor (@semiont/jobs/smelter-main).
 * To rebuild vectors, restart the smelter container — it re-indexes on startup.
 */

console.error('rebuild-vectors: The Smelter now runs as an external actor.');
console.error('To rebuild vectors, restart the smelter container — it re-indexes on startup.');
console.error('See: @semiont/jobs/smelter-main');
process.exit(1);
