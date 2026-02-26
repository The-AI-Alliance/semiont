#!/usr/bin/env node
/**
 * CLI Tool: Rebuild Annotation Projections from Events
 *
 * Rebuilds materialized views from Event Store event streams.
 * Proves that events are the source of truth.
 *
 * Usage:
 *   npm run rebuild-projections              # Rebuild all projections
 *   npm run rebuild-projections <resourceId> # Rebuild specific resource
 */

import { startMakeMeaning } from '@semiont/make-meaning';
import { EventQuery, EventValidator } from '@semiont/event-sourcing';
import { resourceId as makeResourceId, EventBus } from '@semiont/core';
import { loadEnvironmentConfig } from '../utils/config';
import { initializeLogger, getLogger } from '../logger';

async function rebuildProjections(rId?: string) {
  // Load config - uses SEMIONT_ROOT and SEMIONT_ENV from environment
  const projectRoot = process.env.SEMIONT_ROOT;
  if (!projectRoot) {
    throw new Error('SEMIONT_ROOT environment variable is not set');
  }
  const environment = process.env.SEMIONT_ENV || 'development';

  const config = loadEnvironmentConfig(projectRoot, environment);

  // Initialize logger
  initializeLogger(config.logLevel);
  const logger = getLogger();

  logger.info('Rebuilding annotation projections from events');

  // Create EventBus
  const eventBus = new EventBus();

  // Start make-meaning to get eventStore
  const makeMeaning = await startMakeMeaning(config, eventBus, logger);
  const { eventStore } = makeMeaning;
  const query = new EventQuery(eventStore.log.storage);
  const validator = new EventValidator();

  if (rId) {
    // Rebuild single resource
    logger.info('Rebuilding projection for resource', { resourceId: rId });

    const events = await query.getResourceEvents(makeResourceId(rId));
    if (events.length === 0) {
      logger.error('No events found for resource', { resourceId: rId });
      process.exit(1);
    }

    logger.info('Found events for resource', { resourceId: rId, eventCount: events.length });

    // Validate event chain
    const validation = validator.validateEventChain(events);
    if (!validation.valid) {
      logger.error('Event chain validation failed', { resourceId: rId, errors: validation.errors });
      validation.errors.forEach(err => logger.error('Validation error', { error: err }));
      process.exit(1);
    }
    logger.info('Event chain valid', { resourceId: rId });

    // Rebuild projection
    const stored = await eventStore.views.materializer.materialize(events, makeResourceId(rId));
    if (!stored) {
      logger.error('Failed to build projection', { resourceId: rId });
      process.exit(1);
    }

    logger.info('Projection rebuilt successfully', {
      resourceId: rId,
      name: stored.resource.name,
      annotationCount: stored.annotations.annotations.length,
      entityTypes: stored.resource.entityTypes?.join(', ') || 'none',
      version: stored.annotations.version,
      archived: stored.resource.archived
    });

  } else {
    // Rebuild all projections
    logger.info('Rebuilding all projections');
    logger.info('Note: This scans all event shards - may take time for large datasets');

    // TODO: Implement full directory scan across all shards
    // For now, show usage message
    logger.info('To rebuild all projections, you need to:');
    logger.info(`1. Scan all event shards in ${config.services.filesystem!.path}/events/shards/`);
    logger.info('2. For each resource found, call eventStore.materializer.materialize(resourceId)');
    logger.info('3. Views are automatically saved to ViewStorage');
    logger.info('For now, rebuild individual resources by ID');
  }

  // Shutdown make-meaning
  await makeMeaning.stop();
  eventBus.destroy();

  logger.info('Rebuild projections completed');
}

// Parse command line arguments
const rId = process.argv[2];

rebuildProjections(rId)
  .catch(err => {
    const logger = getLogger();
    logger.error('Rebuild projections failed', {
      error: err.message,
      stack: err.stack
    });
    process.exit(1);
  });