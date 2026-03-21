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
import { resourceId as makeResourceId, EventBus, SemiontProject, loadEnvironmentConfig } from '@semiont/core';
import { makeMeaningConfigFrom } from '../utils/config';
import { initializeLogger, getLogger } from '../logger';

async function rebuildGraph(rId?: string, environment?: string) {
  const projectRoot = process.env.SEMIONT_ROOT;
  if (!projectRoot) {
    throw new Error('SEMIONT_ROOT environment variable is not set');
  }
  // environment: --environment flag > SEMIONT_ENV > fallback
  const env = environment ?? process.env.SEMIONT_ENV ?? 'development';

  const config = loadEnvironmentConfig(projectRoot, env);

  // Initialize logger
  initializeLogger(config.logLevel);
  const logger = getLogger();

  logger.info('Rebuilding Neo4j graph from events');

  // Create EventBus
  const eventBus = new EventBus();

  // Start make-meaning to get eventStore and graphConsumer
  const makeMeaning = await startMakeMeaning(new SemiontProject(projectRoot), makeMeaningConfigFrom(config), eventBus, logger);
  const { graphConsumer: consumer } = makeMeaning;

  if (rId) {
    // Rebuild single resource
    logger.info('Rebuilding graph for resource', { resourceId: rId });

    try {
      await consumer.rebuildResource(makeResourceId(rId));
      logger.info('Resource rebuilt successfully', { resourceId: rId });
    } catch (error) {
      logger.error('Failed to rebuild resource', {
        resourceId: rId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      process.exit(1);
    }

  } else {
    // Rebuild entire graph
    logger.info('Rebuilding entire Neo4j graph');
    logger.info('Note: This clears the database and replays all events');

    try {
      await consumer.rebuildAll();
      logger.info('Graph rebuilt successfully');

      // Show health metrics
      const health = consumer.getHealthMetrics();
      logger.info('Consumer health metrics', {
        activeSubscriptions: health.subscriptions,
        resourcesProcessed: Object.keys(health.lastProcessed).length
      });

    } catch (error) {
      logger.error('Failed to rebuild graph', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      process.exit(1);
    }
  }

  // Shutdown make-meaning
  await makeMeaning.stop();
  eventBus.destroy();

  logger.info('Rebuild graph completed');
}

// Parse command line arguments: [resourceId] [--environment <env>]
const args = process.argv.slice(2);
const envFlagIdx = args.indexOf('--environment');
const envArg = envFlagIdx !== -1 ? args[envFlagIdx + 1] : undefined;
const rId = args.find((_, i) => i !== envFlagIdx && i !== envFlagIdx + 1);

rebuildGraph(rId, envArg)
  .catch(err => {
    const logger = getLogger();
    logger.error('Rebuild graph failed', {
      error: err.message,
      stack: err.stack
    });
    process.exit(1);
  });
