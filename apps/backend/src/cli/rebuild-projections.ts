#!/usr/bin/env node
/**
 * CLI Tool: Rebuild Annotation Projections from Events
 *
 * Rebuilds Layer 3 annotation projections from Layer 2 event streams.
 * Proves that events are the source of truth.
 *
 * Usage:
 *   npm run rebuild-projections              # Rebuild all projections
 *   npm run rebuild-projections <documentId> # Rebuild specific document
 */

import { getEventStore } from '../events/event-store';
import { getProjectionStorage } from '../storage/projection-storage';
import { getFilesystemConfig } from '../config/environment-loader';

async function rebuildProjections(documentId?: string) {
  console.log('🔄 Rebuilding annotation projections from events...\n');

  const config = getFilesystemConfig();
  const projectionStorage = getProjectionStorage();
  const eventStore = await getEventStore({
    dataDir: config.path,
  });

  if (documentId) {
    // Rebuild single document
    console.log(`📄 Rebuilding projection for document: ${documentId}`);

    const events = await eventStore.getDocumentEvents(documentId);
    if (events.length === 0) {
      console.error(`❌ No events found for document: ${documentId}`);
      process.exit(1);
    }

    console.log(`   Found ${events.length} events`);

    // Validate event chain
    const validation = await eventStore.validateEventChain(documentId);
    if (!validation.valid) {
      console.error(`❌ Event chain validation failed:`);
      validation.errors.forEach(err => console.error(`   - ${err}`));
      process.exit(1);
    }
    console.log(`   ✅ Event chain valid`);

    // Rebuild projection
    const projection = await eventStore.projectDocument(documentId);
    if (!projection) {
      console.error(`❌ Failed to build projection`);
      process.exit(1);
    }

    console.log(`   ✅ Projection rebuilt:`);
    console.log(`      - Name: ${projection.name}`);
    console.log(`      - Highlights: ${projection.highlights.length}`);
    console.log(`      - References: ${projection.references.length}`);
    console.log(`      - Entity Types: ${projection.entityTypes.join(', ') || 'none'}`);
    console.log(`      - Version: ${projection.version}`);
    console.log(`      - Archived: ${projection.archived}`);

  } else {
    // Rebuild all projections
    console.log(`📚 Rebuilding all projections...`);
    console.log(`   (Note: This scans all event shards - may take time for large datasets)\n`);

    // TODO: Implement full directory scan across all shards
    // For now, show usage message
    console.log(`   To rebuild all projections, you need to:`);
    console.log(`   1. Scan all event shards in ${config.path}/events/shards/`);
    console.log(`   2. For each document found, call eventStore.projectDocument(documentId)`);
    console.log(`   3. Projections are automatically saved to Layer 3\n`);
    console.log(`   For now, rebuild individual documents by ID.`);
  }

  console.log(`\n✅ Done!`);
}

// Parse command line arguments
const documentId = process.argv[2];

rebuildProjections(documentId)
  .catch(err => {
    console.error(`\n❌ Error:`, err.message);
    process.exit(1);
  });