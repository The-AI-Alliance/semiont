/**
 * Import Command
 *
 * Imports a knowledge base from a backup or snapshot file.
 *
 * Replays events through EventBus → Stower so all derived state
 * (materialized views, graph) rebuilds naturally.
 *
 * Usage:
 *   semiont import --file backup.tar.gz
 *   semiont import --format snapshot --file snapshot.jsonl
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import type { Logger, UserId } from '@semiont/core';
import { EventBus } from '@semiont/core';
import { createEventStore } from '@semiont/event-sourcing';
import { importBackup, importSnapshot, Stower, createKnowledgeBase } from '@semiont/make-meaning';
import type { GraphDatabase } from '@semiont/graph';
import { CommandResults } from '../command-types.js';
import { CommandBuilder } from '../command-definition.js';
import { BaseOptionsSchema } from '../base-options-schema.js';
import { printInfo, printSuccess } from '../io/cli-logger.js';
import { loadEnvironmentConfig, findProjectRoot } from '../config-loader.js';

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
 * Noop graph database for import — the graph rebuilds from events
 * after import via the GraphDBConsumer, not during import.
 */
function createNoopGraphDatabase(): GraphDatabase {
  const noop = async (): Promise<never> => { throw new Error('Graph not available during import'); };
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

export const ImportOptionsSchema = BaseOptionsSchema.extend({
  format: z.enum(['backup', 'snapshot']).default('backup'),
  file: z.string().min(1, 'Input file path is required'),
  userId: z.string().default('did:web:localhost:users:import'),
});

export type ImportOptions = z.output<typeof ImportOptionsSchema>;

// =====================================================================
// IMPLEMENTATION
// =====================================================================

export async function runImport(options: ImportOptions): Promise<CommandResults> {
  const startTime = Date.now();

  const projectRoot = process.env.SEMIONT_ROOT || findProjectRoot();
  const environment = options.environment!;
  const envConfig = loadEnvironmentConfig(projectRoot, environment);

  const configuredPath = envConfig.services?.filesystem?.path;
  if (!configuredPath) {
    throw new Error('services.filesystem.path is required in environment config');
  }

  const baseUrl = envConfig.services?.backend?.publicURL;
  if (!baseUrl) {
    throw new Error('services.backend.publicURL is required in environment config');
  }

  const basePath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(projectRoot, configuredPath);

  const logger = createCliLogger(options.verbose ?? false);

  const filePath = path.resolve(options.file);
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  if (!options.quiet) {
    printInfo(`Importing ${options.format} from ${filePath}`);
  }

  // Bootstrap EventBus + Stower for import
  const eventBus = new EventBus();
  const eventStore = createEventStore(basePath, baseUrl, undefined, eventBus, logger);
  const kb = createKnowledgeBase(eventStore, basePath, projectRoot, createNoopGraphDatabase(), logger);
  const stower = new Stower(kb, baseUrl, eventBus, logger.child({ component: 'stower' }));
  await stower.initialize();

  try {
    if (options.format === 'backup') {
      const input = fs.createReadStream(filePath);
      const result = await importBackup(input, { eventBus, logger });

      if (!options.quiet) {
        printSuccess(
          `Backup imported: ${result.stats.eventsReplayed} events, ` +
          `${result.stats.resourcesCreated} resources, ` +
          `${result.stats.annotationsCreated} annotations` +
          (result.hashChainValid ? '' : ' (WARNING: hash chain invalid)')
        );
      }

      const duration = Date.now() - startTime;
      return {
        command: 'import',
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
    } else {
      // Snapshot
      const input = fs.createReadStream(filePath);
      const result = await importSnapshot(input, {
        eventBus,
        userId: options.userId as UserId,
        logger,
      });

      if (!options.quiet) {
        printSuccess(
          `Snapshot imported: ${result.resourcesCreated} resources, ` +
          `${result.annotationsCreated} annotations, ` +
          `${result.entityTypesAdded} entity types`
        );
      }

      const duration = Date.now() - startTime;
      return {
        command: 'import',
        environment,
        timestamp: new Date(),
        duration,
        summary: { succeeded: 1, failed: 0, total: 1, warnings: 0 },
        executionContext: { user: process.env.USER || 'unknown', workingDirectory: process.cwd(), dryRun: options.dryRun },
        results: [{
          entity: filePath,
          platform: 'posix',
          success: true,
          metadata: { format: 'snapshot', ...result },
          duration,
        }],
      };
    }
  } finally {
    await stower.stop();
  }
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const importCmd = new CommandBuilder()
  .name('import')
  .description('Import knowledge base from backup or snapshot')
  .requiresEnvironment(true)
  .requiresServices(false)
  .examples(
    'semiont import --file backup.tar.gz',
    'semiont import --format snapshot --file snapshot.jsonl',
    'semiont import --format snapshot --file snapshot.jsonl --user-id did:web:example.com:users:alice',
  )
  .args({
    args: {
      '--format': {
        type: 'string',
        description: 'Import format: backup or snapshot',
        default: 'backup',
        choices: ['backup', 'snapshot'] as const,
      },
      '--file': {
        type: 'string',
        description: 'Input file path (required)',
      },
      '--user-id': {
        type: 'string',
        description: 'User DID for snapshot import (default: did:web:localhost:users:import)',
        default: 'did:web:localhost:users:import',
      },
    },
    aliases: {
      '-f': '--file',
    },
  })
  .schema(ImportOptionsSchema)
  .handler(runImport)
  .build();
