/**
 * Import Command
 *
 * Imports resources from a JSON-LD Linked Data archive.
 * Creates new resources through the EventBus → Stower pipeline.
 * This is lossy — original resource IDs are not preserved.
 *
 * Usage:
 *   semiont import --file export.tar.gz
 *   semiont import --file export.tar.gz --user-id did:web:example.com:users:alice
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import type { Logger, UserId } from '@semiont/core';
import { EventBus, SemiontProject } from '@semiont/core';
import { createEventStore } from '@semiont/event-sourcing';
import { importLinkedData, Stower, createKnowledgeBase } from '@semiont/make-meaning';
import type { GraphDatabase } from '@semiont/graph';
import { CommandResults } from '../command-types.js';
import { CommandBuilder } from '../command-definition.js';
import { BaseOptionsSchema } from '../base-options-schema.js';
import { printInfo, printSuccess } from '../io/cli-logger.js';
import { findProjectRoot } from '../config-loader.js';

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
  file: z.string().min(1, 'Input file path is required'),
  userId: z.string().optional(),
});

export type ImportOptions = z.output<typeof ImportOptionsSchema>;

// =====================================================================
// IMPLEMENTATION
// =====================================================================

export async function runImport(options: ImportOptions): Promise<CommandResults> {
  const startTime = Date.now();

  const projectRoot = findProjectRoot();
  const environment = options.environment!;

  const project = new SemiontProject(projectRoot);
  const basePath = project.dataDir;

  const logger = createCliLogger(options.verbose ?? false);

  const filePath = path.resolve(options.file);
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const userId = (options.userId ?? `did:web:localhost:users:${process.env.USER ?? 'cli'}`) as UserId;

  if (!options.quiet) {
    printInfo(`Importing JSON-LD archive from ${filePath}`);
    printInfo(`User identity: ${userId}`);
  }

  // Bootstrap EventBus + Stower for import
  const eventBus = new EventBus();
  const stateDir = project.stateDir;
  const eventStore = createEventStore(basePath, stateDir, undefined, eventBus, logger);
  const kb = createKnowledgeBase(eventStore, stateDir, basePath, projectRoot, createNoopGraphDatabase(), logger);
  const stower = new Stower(kb, eventBus, logger.child({ component: 'stower' }));
  await stower.initialize();

  try {
    const input = fs.createReadStream(filePath);
    const result = await importLinkedData(input, { eventBus, userId, logger });

    if (!options.quiet) {
      printSuccess(
        `Import complete: ${result.resourcesCreated} resources, ` +
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
        metadata: {
          format: 'linked-data',
          resourcesCreated: result.resourcesCreated,
          annotationsCreated: result.annotationsCreated,
          entityTypesAdded: result.entityTypesAdded,
        },
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

export const importCmd = new CommandBuilder()
  .name('import')
  .description('Import resources from a JSON-LD Linked Data archive')
  .requiresEnvironment(true)
  .requiresServices(false)
  .examples(
    'semiont import --file export.tar.gz',
    'semiont import --file export.tar.gz --user-id did:web:example.com:users:alice',
  )
  .args({
    args: {
      '--file': {
        type: 'string',
        description: 'Input file path (required)',
      },
      '--user-id': {
        type: 'string',
        description: 'User identity for imported resources (default: current user)',
      },
    },
    aliases: {
      '-f': '--file',
    },
  })
  .schema(ImportOptionsSchema)
  .handler(runImport)
  .build();
