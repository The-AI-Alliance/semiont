/**
 * Yield Command
 *
 * Registers one or more existing files as semiont resources, or records
 * a content update for already-tracked files.
 *
 * Usage:
 *   semiont yield docs/overview.md
 *   semiont yield docs/**\/*.md
 *   semiont yield docs/new-file.md --name "Overview Document"
 */

import * as path from 'path';
import { promises as nodeFs } from 'fs';
import { createHash } from 'crypto';
import { z } from 'zod';
import { SemiontProject } from '@semiont/core/node';
import { EventBus, resourceId as toResourceId, type Logger, type UserId } from '@semiont/core';
import { createEventStore } from '@semiont/event-sourcing';
import { resolveStorageUri, ResourceNotFoundError } from '@semiont/event-sourcing';
import { Stower, createKnowledgeBase } from '@semiont/make-meaning';
import type { GraphDatabase } from '@semiont/graph';
import { CommandResults } from '../command-types.js';
import { CommandBuilder } from '../command-definition.js';
import { BaseOptionsSchema, withBaseArgs } from '../base-options-schema.js';
import { printSuccess, printWarning } from '../io/cli-logger.js';
import { findProjectRoot } from '../config-loader.js';
import { checkGitAvailable } from '../handlers/preflight-utils.js';

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
  const noop = async (): Promise<never> => { throw new Error('Graph not available during yield'); };
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

async function checksumFile(absPath: string): Promise<string> {
  const buf = await nodeFs.readFile(absPath);
  return createHash('sha256').update(buf).digest('hex');
}

function guessFormat(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.json': 'application/json',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
  };
  return map[ext] ?? 'application/octet-stream';
}

// =====================================================================
// SCHEMA
// =====================================================================

export const YieldOptionsSchema = BaseOptionsSchema.extend({
  files: z.array(z.string()).min(1, 'At least one file path is required'),
  name: z.string().optional(),
  noGit: z.boolean().default(false),
});

export type YieldOptions = z.output<typeof YieldOptionsSchema>;

// =====================================================================
// IMPLEMENTATION
// =====================================================================

export async function runYield(options: YieldOptions): Promise<CommandResults> {
  const startTime = Date.now();
  const projectRoot = findProjectRoot();
  const environment = options.environment!;
  const logger = createCliLogger(options.verbose ?? false);
  const userId = `did:web:localhost:users:${process.env.USER ?? 'cli'}` as UserId;

  if (options.name && options.files.length > 1) {
    throw new Error('--name can only be used when yielding a single file');
  }

  const project = new SemiontProject(projectRoot);

  if (project.gitSync && !options.noGit) {
    const gitCheck = checkGitAvailable();
    if (!gitCheck.pass) throw new Error(gitCheck.message);
  }

  const eventBus = new EventBus();
  const eventStore = createEventStore(project, eventBus, logger);
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

      // Verify file exists
      try {
        await nodeFs.access(absPath);
      } catch {
        if (!options.quiet) printWarning(`File not found: ${filePath}`);
        results.push({ entity: filePath, platform: 'posix', success: false, metadata: { error: 'File not found' }, duration: 0 });
        failed++;
        continue;
      }

      // Compute relative path from project root → storageUri
      const relPath = path.relative(projectRoot, absPath).replace(/\\/g, '/');
      const storageUri = `file://${relPath}`;

      // Check if already tracked
      let isTracked = false;
      let existingResourceId: string | undefined;
      try {
        existingResourceId = await resolveStorageUri(kb.projectionsDir, storageUri);
        isTracked = true;
      } catch (e) {
        if (!(e instanceof ResourceNotFoundError)) throw e;
      }

      const format = guessFormat(filePath);
      const contentChecksum = await checksumFile(absPath);
      const fileStart = Date.now();

      if (!isTracked) {
        // New file — emit yield:create (CLI path: no content, file already on disk)
        const name = options.name ?? path.basename(filePath, path.extname(filePath));
        const created = await new Promise<string>((resolve, reject) => {
          const sub = eventBus.get('yield:created').subscribe(e => { sub.unsubscribe(); resolve(e.resourceId); });
          eventBus.get('yield:create-failed').subscribe(e => reject(e.error));
          eventBus.get('yield:create').next({ name, storageUri, contentChecksum, format, userId, noGit: options.noGit });
        });

        if (!options.quiet) printSuccess(`Yielded: ${filePath} → ${created}`);
        results.push({ entity: filePath, platform: 'posix', success: true, metadata: { resourceId: created, storageUri }, duration: Date.now() - fileStart });
        succeeded++;
      } else {
        // Already tracked — check for content change
        // Get current checksum from view (read resource view)
        // Emit yield:update (no content — file already changed on disk)
        const updated = await new Promise<void>((resolve, reject) => {
          const sub = eventBus.get('yield:updated').subscribe(() => { sub.unsubscribe(); resolve(); });
          eventBus.get('yield:update-failed').subscribe(e => reject(e.error));
          eventBus.get('yield:update').next({
            resourceId: toResourceId(existingResourceId!),
            storageUri,
            contentChecksum,
            userId,
            noGit: options.noGit,
          });
        });
        void updated;
        if (!options.quiet) printSuccess(`Updated: ${filePath} (${existingResourceId})`);
        results.push({ entity: filePath, platform: 'posix', success: true, metadata: { resourceId: existingResourceId, storageUri }, duration: Date.now() - fileStart });
        succeeded++;
      }
    }
  } finally {
    await stower.stop();
    eventBus.destroy();
  }

  const duration = Date.now() - startTime;
  return {
    command: 'yield',
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

export const yieldCmd = new CommandBuilder()
  .name('yield')
  .description('Register existing files as semiont resources, or record content updates for tracked files')
  .requiresEnvironment(true)
  .requiresServices(false)
  .examples(
    'semiont yield docs/overview.md',
    'semiont yield docs/new.md --name "Overview Document"',
  )
  .args({
    ...withBaseArgs({
      '--name': {
        type: 'string',
        description: 'Resource name (only valid for a single new file)',
      },
      '--no-git': {
        type: 'boolean',
        description: 'Skip git add even when gitSync is configured',
        default: false,
      },
    }, {
      '-n': '--name',
    }),
    restAs: 'files',
  })
  .schema(YieldOptionsSchema)
  .handler(runYield)
  .build();
