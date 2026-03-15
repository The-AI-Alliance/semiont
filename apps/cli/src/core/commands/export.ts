/**
 * Export Command
 *
 * Exports the knowledge base as a JSON-LD Linked Data archive.
 * Reads materialized views (current state, not event history).
 *
 * Usage:
 *   semiont export --out export.tar.gz
 *   semiont export --include-archived --out full-export.tar.gz
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import type { Logger } from '@semiont/core';
import { createEventStore } from '@semiont/event-sourcing';
import { FilesystemRepresentationStore } from '@semiont/content';
import { exportLinkedData } from '@semiont/make-meaning';
import { readEntityTypesProjection } from '@semiont/make-meaning';
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
  out: z.string().min(1, 'Output path is required'),
  includeArchived: z.boolean().optional().default(false),
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
  const eventStore = createEventStore(basePath, undefined, undefined, logger);
  const contentStore = new FilesystemRepresentationStore(
    { basePath },
    projectRoot,
    logger.child({ component: 'representation-store' }),
  );

  // Read entity types from the entity-types projection
  const entityTypes = await readEntityTypesProjection({
    services: { filesystem: envConfig.services!.filesystem! },
    _metadata: { projectRoot },
  });

  const outPath = path.resolve(options.out);

  if (!options.quiet) {
    printInfo(`Exporting knowledge base as JSON-LD to ${outPath}`);
    if (options.includeArchived) {
      printInfo('Including archived resources');
    }
  }

  const output = fs.createWriteStream(outPath);
  const manifest = await exportLinkedData(
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

  const resourceCount = manifest['void:entities'];

  if (!options.quiet) {
    printSuccess(`Export complete: ${resourceCount} resources`);
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
      metadata: { format: 'linked-data', resources: resourceCount },
      duration,
    }],
  };
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const exportCmd = new CommandBuilder()
  .name('export')
  .description('Export the knowledge base as JSON-LD Linked Data')
  .requiresEnvironment(true)
  .requiresServices(false)
  .examples(
    'semiont export --out export.tar.gz',
    'semiont export --include-archived --out full-export.tar.gz',
  )
  .args({
    args: {
      '--out': {
        type: 'string',
        description: 'Output file path (required)',
      },
      '--include-archived': {
        type: 'boolean',
        description: 'Include archived resources in export',
      },
    },
    aliases: {},
  })
  .schema(ExportOptionsSchema)
  .handler(runExport)
  .build();
