/**
 * Archive Command
 *
 * Archives one or more tracked semiont resources.
 * Runs git rm (or fs.unlink) and appends resource.archived to the event log.
 *
 * Usage:
 *   semiont archive docs/old.md
 *   semiont archive docs/old.md --keep-file
 */

import * as path from 'path';
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
import { checkGitAvailable } from '../handlers/preflight-utils.js';
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
  const noop = async (): Promise<never> => { throw new Error('Graph not available during archive'); };
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

export const ArchiveOptionsSchema = BaseOptionsSchema.extend({
  files: z.array(z.string()).min(1, 'At least one file path is required'),
  keepFile: z.boolean().default(false),
  noGit: z.boolean().default(false),
});

export type ArchiveOptions = z.output<typeof ArchiveOptionsSchema>;

// =====================================================================
// IMPLEMENTATION
// =====================================================================

export async function runArchive(options: ArchiveOptions): Promise<CommandResults> {
  const startTime = Date.now();
  const projectRoot = findProjectRoot();
  const environment = options.environment!;
  const logger = createCliLogger(options.verbose ?? false);
  const userId = `did:web:localhost:users:${process.env.USER ?? 'cli'}` as UserId;

  const project = new SemiontProject(projectRoot);

  if (project.gitSync && !options.noGit) {
    const gitCheck = checkGitAvailable();
    if (!gitCheck.pass) throw new Error(gitCheck.message);
  }

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

      // Resolve resourceId from storage-uri-index
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

      // Emit mark:archive on the resource-scoped bus (Stower handles resource-scoped events)
      eventBus.scope(resourceId).get('mark:archive').next({
        userId,
        resourceId: resourceId as ResourceId,
        storageUri,
        keepFile: options.keepFile,
        noGit: options.noGit,
      });

      // Give Stower time to process (mark:archive has no result event)
      await new Promise(resolve => setTimeout(resolve, 200));

      if (!options.quiet) printSuccess(`Archived: ${filePath}`);
      results.push({ entity: filePath, platform: 'posix', success: true, metadata: { resourceId, storageUri }, duration: Date.now() - fileStart });
      succeeded++;
    }
  } finally {
    await stower.stop();
    eventBus.destroy();
  }

  const duration = Date.now() - startTime;
  return {
    command: 'archive',
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

export const archiveCmd = new CommandBuilder()
  .name('archive')
  .description('Archive tracked semiont resources (removes file from git and disk)')
  .requiresEnvironment(true)
  .requiresServices(false)
  .examples(
    'semiont archive docs/old.md',
    'semiont archive docs/old.md --keep-file',
  )
  .args({
    args: {
      '--keep-file': {
        type: 'boolean',
        description: 'Remove from git index only — keep file on disk',
        default: false,
      },
      '--no-git': {
        type: 'boolean',
        description: 'Skip git rm even when gitSync is configured',
        default: false,
      },
    },
    aliases: {},
    restAs: 'files',
  })
  .schema(ArchiveOptionsSchema)
  .handler(runArchive)
  .build();
