/**
 * Export Command
 *
 * Exports the knowledge base to a file.
 *
 * Formats:
 * - backup: Lossless tar.gz of event log + content store (default)
 * - snapshot: Current-state JSONL of resources + annotations
 *
 * Usage:
 *   semiont export --out backup.tar.gz
 *   semiont export --format snapshot --out snapshot.jsonl
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import type { Logger, ResourceId } from '@semiont/core';
import { createEventStore } from '@semiont/event-sourcing';
import { FilesystemRepresentationStore } from '@semiont/content';
import { exportBackup, exportSnapshot } from '@semiont/make-meaning';
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

// =====================================================================
// SCHEMA
// =====================================================================

export const ExportOptionsSchema = BaseOptionsSchema.extend({
  format: z.enum(['backup', 'snapshot']).default('backup'),
  out: z.string().min(1, 'Output path is required'),
  includeArchived: z.boolean().default(false),
});

export type ExportOptions = z.output<typeof ExportOptionsSchema>;

// =====================================================================
// IMPLEMENTATION
// =====================================================================

export async function runExport(options: ExportOptions): Promise<CommandResults> {
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

  // Bootstrap read-only stores
  const eventStore = createEventStore(basePath, baseUrl, undefined, undefined, logger);
  const contentStore = new FilesystemRepresentationStore(
    { basePath },
    projectRoot,
    logger.child({ component: 'representation-store' }),
  );

  const outPath = path.resolve(options.out);

  if (!options.quiet) {
    printInfo(`Exporting ${options.format} to ${outPath}`);
  }

  if (options.format === 'backup') {
    const output = fs.createWriteStream(outPath);
    const manifest = await exportBackup(
      { eventStore, content: contentStore, sourceUrl: baseUrl, logger },
      output,
    );

    if (!options.quiet) {
      printSuccess(
        `Backup exported: ${manifest.stats.streams} streams, ` +
        `${manifest.stats.events} events, ${manifest.stats.blobs} blobs`
      );
    }

    const duration = Date.now() - startTime;
    return {
      command: 'export',
      environment,
      timestamp: new Date(),
      duration,
      summary: { succeeded: 1, failed: 0, total: 1, warnings: 0 },
      executionContext: { user: process.env.USER || 'unknown', workingDirectory: process.cwd(), dryRun: options.dryRun },
      results: [{
        entity: outPath,
        platform: 'posix',
        success: true,
        metadata: { format: 'backup', ...manifest.stats },
        duration,
      }],
    };
  } else {
    // Snapshot — read entity types from the system event stream
    const systemEvents = await eventStore.log.getEvents('__system__' as ResourceId);
    const entityTypes = systemEvents
      .filter((se) => se.event.type === 'entitytype.added')
      .map((se) => (se.event.payload as { entityType: string }).entityType);

    const output = fs.createWriteStream(outPath);
    const manifest = await exportSnapshot(
      {
        views: eventStore.viewStorage,
        content: contentStore,
        sourceUrl: baseUrl,
        entityTypes,
        includeArchived: options.includeArchived,
        logger,
      },
      output,
    );

    if (!options.quiet) {
      printSuccess(`Snapshot exported: ${manifest.stats.resources} resources`);
    }

    const duration = Date.now() - startTime;
    return {
      command: 'export',
      environment,
      timestamp: new Date(),
      duration,
      summary: { succeeded: 1, failed: 0, total: 1, warnings: 0 },
      executionContext: { user: process.env.USER || 'unknown', workingDirectory: process.cwd(), dryRun: options.dryRun },
      results: [{
        entity: outPath,
        platform: 'posix',
        success: true,
        metadata: { format: 'snapshot', ...manifest.stats },
        duration,
      }],
    };
  }
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const exportCmd = new CommandBuilder()
  .name('export')
  .description('Export knowledge base (backup or snapshot)')
  .requiresEnvironment(true)
  .requiresServices(false)
  .examples(
    'semiont export --out backup.tar.gz',
    'semiont export --format snapshot --out snapshot.jsonl',
    'semiont export --format snapshot --include-archived --out full.jsonl',
  )
  .args({
    args: {
      '--format': {
        type: 'string',
        description: 'Export format: backup (lossless tar.gz) or snapshot (current-state JSONL)',
        default: 'backup',
        choices: ['backup', 'snapshot'] as const,
      },
      '--out': {
        type: 'string',
        description: 'Output file path (required)',
      },
      '--include-archived': {
        type: 'boolean',
        description: 'Include archived resources in snapshot export',
        default: false,
      },
    },
    aliases: {},
  })
  .schema(ExportOptionsSchema)
  .handler(runExport)
  .build();
