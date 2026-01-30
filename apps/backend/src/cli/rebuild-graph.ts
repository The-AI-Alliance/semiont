#!/usr/bin/env node
/**
 * CLI Tool: Rebuild Neo4j Graph from Events
 *
 * Rebuilds the Neo4j graph database from Event Store event streams.
 * Proves that events are the source of truth and Neo4j is a projection.
 *
 * Usage:
 *   npm run rebuild-graph              # Rebuild entire graph
 *   npm run rebuild-graph <resourceId> # Rebuild specific resource
 */

import { startMakeMeaning } from '@semiont/make-meaning';
import { loadEnvironmentConfig, resourceId as makeResourceId } from '@semiont/core';

async function rebuildGraph(rId?: string) {
  console.log('🔄 Rebuilding Neo4j graph from events...\n');

  // Load config - uses SEMIONT_ROOT and SEMIONT_ENV from environment
  const projectRoot = process.env.SEMIONT_ROOT || process.cwd();
  const environment = process.env.SEMIONT_ENV || 'development';
  const config = loadEnvironmentConfig(projectRoot, environment);

  // Start make-meaning to get eventStore and graphConsumer
  const makeMeaning = await startMakeMeaning(config);
  const { graphConsumer: consumer } = makeMeaning;

  if (rId) {
    // Rebuild single resource
    console.log(`📄 Rebuilding graph for resource: ${rId}`);

    try {
      await consumer.rebuildResource(makeResourceId(rId));
      console.log(`   ✅ Resource rebuilt successfully`);
    } catch (error) {
      console.error(`   ❌ Failed to rebuild resource:`, error instanceof Error ? error.message : error);
      process.exit(1);
    }

  } else {
    // Rebuild entire graph
    console.log(`📚 Rebuilding entire Neo4j graph...`);
    console.log(`   (Note: This clears the database and replays all events)\n`);

    try {
      await consumer.rebuildAll();
      console.log(`   ✅ Graph rebuilt successfully`);

      // Show health metrics
      const health = consumer.getHealthMetrics();
      console.log(`\n   📊 Consumer Health:`);
      console.log(`      - Active subscriptions: ${health.subscriptions}`);
      console.log(`      - Resources processed: ${Object.keys(health.lastProcessed).length}`);

    } catch (error) {
      console.error(`   ❌ Failed to rebuild graph:`, error instanceof Error ? error.message : error);
      process.exit(1);
    }
  }

  // Shutdown make-meaning
  await makeMeaning.stop();

  console.log(`\n✅ Done!`);
}

// Parse command line arguments
const rId = process.argv[2];

rebuildGraph(rId)
  .catch(err => {
    console.error(`\n❌ Error:`, err.message);
    if (err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  });
