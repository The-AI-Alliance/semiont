/**
 * Restore Command
 *
 * Restores a knowledge base from a backup archive.
 * Replays events through EventBus → Stower so all derived state
 * (materialized views, graph) rebuilds naturally.
 *
 * Usage:
 *   semiont restore --file backup.tar.gz
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import type { Logger } from '@semiont/core';
import { EventBus, getStateDir } from '@semiont/core';
import { createEventStore } from '@semiont/event-sourcing';
import { importBackup, Stower, createKnowledgeBase } from '@semiont/make-meaning';
import type { GraphDatabase } from '@semiont/graph';
import { CommandResults } from '../command-types.js';
import { CommandBuilder } from '../command-definition.js';
import { BaseOptionsSchema } from '../base-options-schema.js';
import { printInfo, printSuccess } from '../io/cli-logger.js';
import { findProjectRoot, readProjectName } from '../config-loader.js';

function createCliLogger(verbose: boolean): Logger {
  return {
    debug: (msg, meta) => { if (verbose) console.log(`[debug] ${msg}`, meta ?? ''); },
    info: (msg, meta) => console.log(`[info] ${msg}`, meta ?? ''),
    warn: (msg, meta) => console.warn(`[warn] ${msg}`, meta ?? ''),
    error: (msg, meta) => console.error(`[error] ${msg}`, meta ?? ''),
    child: () => createCliLogger(verbose),
  };
}

/**
 * Noop graph database for restore — the graph rebuilds from events
 * after restore via the GraphDBConsumer, not during restore.
 */
function createNoopGraphDatabase(): GraphDatabase {
  const noop = async (): Promise<never> => { throw new Error('Graph not available during restore'); };
  return {
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => false,
    createResource: noop,
    getResource: noop,
    updateResource: noop,
    deleteResource: noop,
    listResources: noop,
    searchResources: noop,
    createAnnotation: noop,
    getAnnotation: noop,
    updateAnnotation: noop,
    deleteAnnotation: noop,
    listAnnotations: noop,
    getHighlights: noop,
    resolveReference: noop,
    getReferences: noop,
    getEntityReferences: noop,
    getResourceAnnotations: noop,
    getResourceReferencedBy: noop,
    getResourceConnections: noop,
    findPath: noop,
    getEntityTypeStats: noop,
    getStats: noop,
    batchCreateResources: noop,
    createAnnotations: noop,
    resolveReferences: noop,
    detectAnnotations: noop,
    getEntityTypes: noop,
    addEntityType: noop,
    addEntityTypes: noop,
    generateId: () => 'noop',
    clearDatabase: noop,
  };
}

// =====================================================================
// SCHEMA
// =====================================================================

export const RestoreOptionsSchema = BaseOptionsSchema.extend({
  file: z.string().min(1, 'Input file path is required'),
});

export type RestoreOptions = z.output<typeof RestoreOptionsSchema>;

// =====================================================================
// IMPLEMENTATION
// =====================================================================

export async function runRestore(options: RestoreOptions): Promise<CommandResults> {
  const startTime = Date.now();

  const projectRoot = findProjectRoot();
  const environment = options.environment!;

  const basePath = path.join(projectRoot, '.semiont', 'data');

  const logger = createCliLogger(options.verbose ?? false);

  const filePath = path.resolve(options.file);
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  if (!options.quiet) {
    printInfo(`Restoring from ${filePath}`);
  }

  // Bootstrap EventBus + Stower for restore
  const eventBus = new EventBus();
  const projectionsPath = getStateDir(readProjectName(projectRoot));
  const eventStore = createEventStore(basePath, projectionsPath, undefined, eventBus, logger);
  const kb = createKnowledgeBase(eventStore, basePath, projectRoot, createNoopGraphDatabase(), logger);
  const stower = new Stower(kb, eventBus, logger.child({ component: 'stower' }));
  await stower.initialize();

  try {
    const input = fs.createReadStream(filePath);
    const result = await importBackup(input, { eventBus, logger });

    if (!options.quiet) {
      printSuccess(
        `Restore complete: ${result.stats.eventsReplayed} events, ` +
        `${result.stats.resourcesCreated} resources, ` +
        `${result.stats.annotationsCreated} annotations` +
        (result.hashChainValid ? '' : ' (WARNING: hash chain invalid)')
      );
    }

    const duration = Date.now() - startTime;
    return {
      command: 'restore',
      environment,
      timestamp: new Date(),
      duration,
      summary: {
        succeeded: 1, failed: 0, total: 1,
        warnings: result.hashChainValid ? 0 : 1,
      },
      executionContext: { user: process.env.USER || 'unknown', workingDirectory: process.cwd(), dryRun: options.dryRun },
      results: [{
        entity: filePath,
        platform: 'posix',
        success: true,
        metadata: { format: 'backup', ...result.stats, hashChainValid: result.hashChainValid },
        duration,
      }],
    };
  } finally {
    await stower.stop();
  }
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const restoreCmd = new CommandBuilder()
  .name('restore')
  .description('Restore a knowledge base from a backup archive')
  .requiresEnvironment(true)
  .requiresServices(false)
  .examples(
    'semiont restore --file backup.tar.gz',
  )
  .args({
    args: {
      '--file': {
        type: 'string',
        description: 'Input file path (required)',
      },
    },
    aliases: {
      '-f': '--file',
    },
  })
  .schema(RestoreOptionsSchema)
  .handler(runRestore)
  .build();
