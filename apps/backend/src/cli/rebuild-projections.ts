#!/usr/bin/env node
/**
 * CLI Tool: Rebuild Annotation Projections from Events
 *
 * Rebuilds Layer 3 annotation projections from Layer 2 event streams.
 * Proves that events are the source of truth.
 *
 * Usage:
 *   npm run rebuild-projections              # Rebuild all projections
 *   npm run rebuild-projections <resourceId> # Rebuild specific resource
 */

import { createEventStore, createEventQuery, createEventValidator } from '../services/event-store-service';
import { loadEnvironmentConfig, resourceId as makeResourceId } from '@semiont/core';

async function rebuildProjections(rId?: string) {
  console.log('🔄 Rebuilding annotation projections from events...\n');

  // Load config - uses SEMIONT_ROOT and SEMIONT_ENV from environment
  const projectRoot = process.env.SEMIONT_ROOT || process.cwd();
  const environment = process.env.SEMIONT_ENV || 'development';
  const config = loadEnvironmentConfig(projectRoot, environment);

  const eventStore = await createEventStore( config);
  const query = createEventQuery(eventStore);
  const validator = createEventValidator();

  if (rId) {
    // Rebuild single resource
    console.log(`📄 Rebuilding projection for resource: ${rId}`);

    const events = await query.getResourceEvents(makeResourceId(rId));
    if (events.length === 0) {
      console.error(`❌ No events found for resource: ${rId}`);
      process.exit(1);
    }

    console.log(`   Found ${events.length} events`);

    // Validate event chain
    const validation = validator.validateEventChain(events);
    if (!validation.valid) {
      console.error(`❌ Event chain validation failed:`);
      validation.errors.forEach(err => console.error(`   - ${err}`));
      process.exit(1);
    }
    console.log(`   ✅ Event chain valid`);

    // Rebuild projection
    const stored = await eventStore.projections.projector.projectResource(events, makeResourceId(rId));
    if (!stored) {
      console.error(`❌ Failed to build projection`);
      process.exit(1);
    }

    console.log(`   ✅ Projection rebuilt:`);
    console.log(`      - Name: ${stored.resource.name}`);
    console.log(`      - Annotations: ${stored.annotations.annotations.length}`);
    console.log(`      - Entity Types: ${stored.resource.entityTypes?.join(', ') || 'none'}`);
    console.log(`      - Version: ${stored.annotations.version}`);
    console.log(`      - Archived: ${stored.resource.archived}`);

  } else {
    // Rebuild all projections
    console.log(`📚 Rebuilding all projections...`);
    console.log(`   (Note: This scans all event shards - may take time for large datasets)\n`);

    // TODO: Implement full directory scan across all shards
    // For now, show usage message
    console.log(`   To rebuild all projections, you need to:`);
    console.log(`   1. Scan all event shards in ${config.services.filesystem!.path}/events/shards/`);
    console.log(`   2. For each resource found, call eventStore.projector.projectResource(resourceId)`);
    console.log(`   3. Projections are automatically saved to Layer 3\n`);
    console.log(`   For now, rebuild individual resources by ID.`);
  }

  console.log(`\n✅ Done!`);
}

// Parse command line arguments
const rId = process.argv[2];

rebuildProjections(rId)
  .catch(err => {
    console.error(`\n❌ Error:`, err.message);
    process.exit(1);
  });