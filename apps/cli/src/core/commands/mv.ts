/**
 * Mv Command
 *
 * Moves (renames) a resource's file on disk and records the move in the event log.
 * The resource is identified by its current `file://`-relative storageUri.
 *
 * Usage:
 *   semiont mv docs/old-name.md docs/new-name.md
 */

import { z } from 'zod';
import { SemiontProject } from '@semiont/core/node';
import { EventBus, type Logger, type UserId } from '@semiont/core';
import { createEventStore } from '@semiont/event-sourcing';
import { Stower, createKnowledgeBase } from '@semiont/make-meaning';
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

function createNoopGraphDatabase(): GraphDatabase {
  const noop = async (): Promise<never> => { throw new Error('Graph not available during mv'); };
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

export const MvOptionsSchema = BaseOptionsSchema.extend({
  from: z.string().min(1, 'Source path is required'),
  to: z.string().min(1, 'Destination path is required'),
  noGit: z.boolean().default(false),
});

export type MvOptions = z.output<typeof MvOptionsSchema>;

// =====================================================================
// IMPLEMENTATION
// =====================================================================

export async function runMv(options: MvOptions): Promise<CommandResults> {
  const startTime = Date.now();

  const projectRoot = findProjectRoot();
  const environment = options.environment!;
  const logger = createCliLogger(options.verbose ?? false);

  // Normalise to file:// URIs (strip leading ./ if present)
  const normalise = (p: string) => {
    const stripped = p.replace(/^\.\//, '');
    return stripped.startsWith('file://') ? stripped : `file://${stripped}`;
  };
  const fromUri = normalise(options.from);
  const toUri = normalise(options.to);

  if (!options.quiet) {
    printInfo(`Moving resource: ${fromUri} → ${toUri}`);
  }

  const project = new SemiontProject(projectRoot);
  const eventBus = new EventBus();
  const eventStore = createEventStore(project, undefined, eventBus, logger);
  const kb = createKnowledgeBase(eventStore, project, createNoopGraphDatabase(), logger);
  const stower = new Stower(kb, eventBus, logger.child({ component: 'stower' }));
  await stower.initialize();

  try {
    // Emit yield:mv — Stower resolves resourceId via storage-uri-index, moves file, appends resource.moved
    const movedPromise = new Promise<void>((resolve, reject) => {
      const sub = eventBus.get('yield:moved').subscribe(() => { sub.unsubscribe(); resolve(); });
      eventBus.get('yield:move-failed').subscribe((e) => { reject(new Error(e.error?.message ?? 'Move failed')); });
    });

    const userId = `did:web:localhost:users:${process.env.USER ?? 'cli'}` as UserId;
    eventBus.get('yield:mv').next({ fromUri, toUri, userId, noGit: options.noGit });
    await movedPromise;

    if (!options.quiet) {
      printSuccess(`Moved: ${fromUri} → ${toUri}`);
    }

    const duration = Date.now() - startTime;
    return {
      command: 'mv',
      environment,
      timestamp: new Date(),
      duration,
      summary: { succeeded: 1, failed: 0, total: 1, warnings: 0 },
      executionContext: { user: process.env.USER || 'unknown', workingDirectory: process.cwd(), dryRun: options.dryRun },
      results: [{
        entity: fromUri,
        platform: 'posix',
        success: true,
        metadata: { fromUri, toUri },
        duration,
      }],
    };
  } finally {
    await stower.stop();
    eventBus.destroy();
  }
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const mvCmd = new CommandBuilder()
  .name('mv')
  .description('Move (rename) a tracked resource file and record the move in the event log')
  .requiresEnvironment(true)
  .requiresServices(false)
  .examples(
    'semiont mv docs/old-name.md docs/new-name.md',
    'semiont mv file://docs/old.md file://docs/new.md',
  )
  .args({
    args: {
      '--from': {
        type: 'string',
        description: 'Source path or file:// URI',
      },
      '--to': {
        type: 'string',
        description: 'Destination path or file:// URI',
      },
      '--no-git': {
        type: 'boolean',
        description: 'Skip git mv even when inside a git repository',
      },
    },
    aliases: {},
  })
  .schema(MvOptionsSchema)
  .handler(runMv)
  .build();
