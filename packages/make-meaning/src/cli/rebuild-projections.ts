#!/usr/bin/env node
/**
 * CLI Tool: Rebuild Annotation Projections from Events
 *
 * Rebuilds every materialized view from Event Store event streams.
 * Proves that events are the source of truth. Given a resourceId, it also
 * reports that resource's rebuilt view, and fails if the log holds no events
 * for it.
 *
 * Lives beside the record's owner (the Archivist): a checkout-run operator
 * tool over the event log, never an image binary.
 *
 * Usage:
 *   npm run rebuild-projections --workspace=@semiont/make-meaning -- [resourceId] [--environment <env>]
 */

import { connectRecord } from '../service';
import { makeMeaningConfigFrom } from '../config';
import { EventQuery } from '@semiont/event-sourcing';
import { SemiontProject, loadEnvironmentConfig } from '@semiont/core/node';
import { resourceId as makeResourceId, EventBus } from '@semiont/core';
import { createProcessLogger } from '@semiont/observability/process-logger';

const logger = createProcessLogger('rebuild-projections');

async function rebuildProjections(rId?: string, environment?: string) {
  const projectRoot = process.env.SEMIONT_ROOT;
  if (!projectRoot) {
    throw new Error('SEMIONT_ROOT environment variable is not set');
  }
  // environment: an explicit --environment flag, else the loader resolves it from
  // `[defaults] environment`. No default is chosen here.
  const config = loadEnvironmentConfig(projectRoot, { environment });

  logger.info('Rebuilding annotation projections from events');

  // Create EventBus
  const eventBus = new EventBus();

  // This CLI never touches the anchored-text store, but SemiontProject
  // requires the path to be complete.
  const anchoredTextDir = process.env.SEMIONT_ANCHORED_TEXT_DIR;
  if (!anchoredTextDir) {
    throw new Error(
      'SEMIONT_ANCHORED_TEXT_DIR environment variable is not set (the Archivist and ' +
      'Smelter images declare it as /anchored-text).',
    );
  }

  // Connecting the record IS the rebuild: the record root re-materializes
  // every view from the event log before it returns, and builds no actors and
  // no bus handlers. Asked for outright, so SEMIONT_SKIP_REBUILD cannot turn
  // this tool into a no-op.
  const record = await connectRecord(new SemiontProject(projectRoot, { anchoredTextDir }), makeMeaningConfigFrom(config), eventBus, logger, { skipRebuild: false });
  const { eventStore } = record;
  const query = new EventQuery(eventStore.log.storage);

  if (rId) {
    // Report one resource's view, as the rebuild above left it
    logger.info('Reading rebuilt projection for resource', { resourceId: rId });

    const events = await query.getResourceEvents(makeResourceId(rId));
    if (events.length === 0) {
      logger.error('No events found for resource', { resourceId: rId });
      process.exit(1);
    }

    logger.info('Found events for resource', { resourceId: rId, eventCount: events.length });

    // `materialize` answers the stored view when one exists, which after the
    // rebuild above is the one it just wrote.
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
    logger.info('All projections rebuilt from the event log');
  }

  // Shutdown
  await record.stop();
  eventBus.destroy();

  logger.info('Rebuild projections completed');
}

// Parse command line arguments: [resourceId] [--environment <env>]
const args = process.argv.slice(2);
const envFlagIdx = args.indexOf('--environment');
const envArg = envFlagIdx !== -1 ? args[envFlagIdx + 1] : undefined;
// The first argument that is neither the flag nor its value.
const rId = args.find((_, i) => envFlagIdx === -1 || (i !== envFlagIdx && i !== envFlagIdx + 1));

rebuildProjections(rId, envArg)
  .catch(err => {
    logger.error('Rebuild projections failed', {
      error: err.message,
      stack: err.stack
    });
    process.exit(1);
  });
