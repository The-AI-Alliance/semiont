#!/usr/bin/env node
/**
 * CLI Tool: Rebuild Vector Store from Events
 *
 * Rebuilds the vector store (Qdrant) from persisted embedding events
 * in the event log. Does not re-compute embeddings — replays
 * embedding.computed / embedding.deleted events into the vector store.
 *
 * Usage:
 *   npm run rebuild-vectors
 */

import { startMakeMeaning } from '@semiont/make-meaning';
import { SemiontProject, loadEnvironmentConfig } from '@semiont/core/node';
import { EventBus } from '@semiont/core';
import { makeMeaningConfigFrom } from '../utils/config';
import { initializeLogger, getLogger } from '../logger';

async function rebuildVectors(environment?: string) {
  const projectRoot = process.env.SEMIONT_ROOT;
  if (!projectRoot) {
    throw new Error('SEMIONT_ROOT environment variable is not set');
  }
  const env = environment ?? process.env.SEMIONT_ENV ?? 'development';

  const config = loadEnvironmentConfig(projectRoot, env);

  initializeLogger(config.logLevel);
  const logger = getLogger();

  logger.info('Rebuilding vector store from events');

  const eventBus = new EventBus();

  const makeMeaning = await startMakeMeaning(new SemiontProject(projectRoot), makeMeaningConfigFrom(config), eventBus, logger);
  const { knowledgeSystem: { kb } } = makeMeaning;

  if (!kb.smelter) {
    logger.error('No smelter configured — check vectors and embedding settings in ~/.semiontconfig');
    process.exit(1);
  }

  try {
    await kb.smelter.rebuildAll();
    logger.info('Vector store rebuilt successfully');
  } catch (error) {
    logger.error('Failed to rebuild vector store', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }

  await makeMeaning.stop();
  eventBus.destroy();

  logger.info('Rebuild vectors completed');
}

const args = process.argv.slice(2);
const envFlagIdx = args.indexOf('--environment');
const envArg = envFlagIdx !== -1 ? args[envFlagIdx + 1] : undefined;

rebuildVectors(envArg)
  .catch(err => {
    const logger = getLogger();
    logger.error('Rebuild vectors failed', {
      error: err.message,
      stack: err.stack,
    });
    process.exit(1);
  });
