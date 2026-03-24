/**
 * Unarchive Command
 *
 * Restores one or more archived semiont resources.
 * The file MUST already exist on disk at the storageUri.
 *
 * Usage:
 *   semiont unarchive docs/old.md
 */

import * as path from 'path';
import { promises as nodeFs } from 'fs';
import { z } from 'zod';
import { SemiontProject } from '@semiont/core/node';
import { EventBus, type Logger, type UserId } from '@semiont/core';
import { createEventStore } from '@semiont/event-sourcing';
import { resolveStorageUri, ResourceNotFoundError } from '@semiont/event-sourcing';
import { Stower, createKnowledgeBase } from '@semiont/make-meaning';
import type { GraphDatabase } from '@semiont/graph';
import { CommandResults } from '../command-types.js';
import { CommandBuilder } from '../command-definition.js';
import { BaseOptionsSchema } from '../base-options-schema.js';
import { printSuccess, printWarning } from '../io/cli-logger.js';
import { findProjectRoot } from '../config-loader.js';
import type { ResourceId } from '@semiont/core';

function createCliLogger(verbose: boolean): Logger {
  return {
    debug: (msg, meta) => { if (verbose) console.log(`[debug] ${msg}`, meta ?? ''); },
    info: (msg, meta) => console.log(`[info] ${msg}`, meta ?? ''),
    warn: (msg, meta) => console.warn(`[warn] ${msg}`, meta ?? ''),
    error: (msg, meta) => console.error(`[error] ${msg}`, meta ?? ''),
    child: () => createCliLogger(verbose),
  };
}

function createNoopGraphDatabase(): GraphDatabase {
  const noop = async (): Promise<never> => { throw new Error('Graph not available during unarchive'); };
  return {
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => false,
    createResource: noop, getResource: noop, updateResource: noop, deleteResource: noop,
    listResources: noop, searchResources: noop, createAnnotation: noop, getAnnotation: noop,
    updateAnnotation: noop, deleteAnnotation: noop, listAnnotations: noop, getHighlights: noop,
    resolveReference: noop, getReferences: noop, getEntityReferences: noop,
    getResourceAnnotations: noop, getResourceReferencedBy: noop, getResourceConnections: noop,
    findPath: noop, getEntityTypeStats: noop, getStats: noop, batchCreateResources: noop,
    createAnnotations: noop, resolveReferences: noop, detectAnnotations: noop,
    getEntityTypes: noop, addEntityType: noop, addEntityTypes: noop,
    generateId: () => 'noop', clearDatabase: noop,
  };
}

// =====================================================================
// SCHEMA
// =====================================================================

export const UnarchiveOptionsSchema = BaseOptionsSchema.extend({
  files: z.array(z.string()).min(1, 'At least one file path is required'),
});

export type UnarchiveOptions = z.output<typeof UnarchiveOptionsSchema>;

// =====================================================================
// IMPLEMENTATION
// =====================================================================

export async function runUnarchive(options: UnarchiveOptions): Promise<CommandResults> {
  const startTime = Date.now();
  const projectRoot = findProjectRoot();
  const environment = options.environment!;
  const logger = createCliLogger(options.verbose ?? false);
  const userId = `did:web:localhost:users:${process.env.USER ?? 'cli'}` as UserId;

  const project = new SemiontProject(projectRoot);
  const eventBus = new EventBus();
  const eventStore = createEventStore(project, undefined, eventBus, logger);
  const kb = createKnowledgeBase(eventStore, project, createNoopGraphDatabase(), logger);
  const stower = new Stower(kb, eventBus, logger.child({ component: 'stower' }));
  await stower.initialize();

  let succeeded = 0;
  let failed = 0;
  const results: CommandResults['results'] = [];

  try {
    for (const filePath of options.files) {
      const absPath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(projectRoot, filePath);

      const relPath = path.relative(projectRoot, absPath).replace(/\\/g, '/');
      const storageUri = `file://${relPath}`;
      const fileStart = Date.now();

      // File MUST exist on disk before unarchiving
      try {
        await nodeFs.access(absPath);
      } catch {
        console.error(
          `Error: File not found at storageUri '${storageUri}'\n` +
          `To restore from git: git checkout -- ${relPath}\n` +
          `Then re-run: semiont unarchive ${filePath}`
        );
        results.push({ entity: filePath, platform: 'posix', success: false, metadata: { error: 'File not found on disk' }, duration: 0 });
        failed++;
        continue;
      }

      // Resolve resourceId from storage-uri-index (index is retained on archive)
      let resourceId: string;
      try {
        resourceId = await resolveStorageUri(kb.projectionsDir, storageUri);
      } catch (e) {
        if (e instanceof ResourceNotFoundError) {
          if (!options.quiet) printWarning(`Not tracked by semiont: ${filePath}`);
          results.push({ entity: filePath, platform: 'posix', success: false, metadata: { error: 'Not tracked' }, duration: 0 });
          failed++;
          continue;
        }
        throw e;
      }

      // Emit mark:unarchive on resource-scoped bus
      eventBus.scope(resourceId).get('mark:unarchive').next({
        userId,
        resourceId: resourceId as ResourceId,
        storageUri,
      });

      // Give Stower time to process
      await new Promise(resolve => setTimeout(resolve, 200));

      if (!options.quiet) printSuccess(`Unarchived: ${filePath}`);
      results.push({ entity: filePath, platform: 'posix', success: true, metadata: { resourceId, storageUri }, duration: Date.now() - fileStart });
      succeeded++;
    }
  } finally {
    await stower.stop();
    eventBus.destroy();
  }

  const duration = Date.now() - startTime;
  return {
    command: 'unarchive',
    environment,
    timestamp: new Date(),
    duration,
    summary: { succeeded, failed, total: options.files.length, warnings: 0 },
    executionContext: { user: process.env.USER || 'unknown', workingDirectory: process.cwd(), dryRun: options.dryRun },
    results,
  };
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const unarchiveCmd = new CommandBuilder()
  .name('unarchive')
  .description('Restore an archived semiont resource (file must already exist on disk)')
  .requiresEnvironment(true)
  .requiresServices(false)
  .examples(
    'semiont unarchive docs/old.md',
  )
  .args({
    args: {},
    aliases: {},
    restAs: 'files',
  })
  .schema(UnarchiveOptionsSchema)
  .handler(runUnarchive)
  .build();
