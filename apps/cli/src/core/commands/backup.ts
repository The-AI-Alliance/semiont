/**
 * Backup Command
 *
 * Creates a lossless backup of the knowledge base.
 * Produces a tar.gz archive containing the event log and content store.
 *
 * Usage:
 *   semiont backup --out backup.tar.gz
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { SemiontProject } from '@semiont/core/node';
import type { Logger } from '@semiont/core';
import { createEventStore } from '@semiont/event-sourcing';
import { WorkingTreeStore } from '@semiont/content';
import { exportBackup } from '@semiont/make-meaning';
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

export const BackupOptionsSchema = BaseOptionsSchema.extend({
  out: z.string().min(1, 'Output path is required'),
});

export type BackupOptions = z.output<typeof BackupOptionsSchema>;

// =====================================================================
// IMPLEMENTATION
// =====================================================================

export async function runBackup(options: BackupOptions): Promise<CommandResults> {
  const startTime = Date.now();

  const projectRoot = findProjectRoot();
  const environment = options.environment!;
  const envConfig = loadEnvironmentConfig(projectRoot, environment);

  const baseUrl = envConfig.services?.backend?.publicURL;
  if (!baseUrl) {
    throw new Error('services.backend.publicURL is required in environment config');
  }

  const project = new SemiontProject(projectRoot);
  const logger = createCliLogger(options.verbose ?? false);

  // Bootstrap read-only stores
  const eventStore = createEventStore(project, undefined, logger);
  const contentStore = new WorkingTreeStore(
    project,
    logger.child({ component: 'content-store' }),
  );

  const outPath = path.resolve(options.out);

  if (!options.quiet) {
    printInfo(`Creating backup at ${outPath}`);
  }

  const output = fs.createWriteStream(outPath);
  const manifest = await exportBackup(
    { eventStore, content: contentStore, sourceUrl: baseUrl, logger },
    output,
  );

  if (!options.quiet) {
    printSuccess(
      `Backup complete: ${manifest.stats.streams} streams, ` +
      `${manifest.stats.events} events, ${manifest.stats.blobs} blobs`
    );
  }

  const duration = Date.now() - startTime;
  return {
    command: 'backup',
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
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const backupCmd = new CommandBuilder()
  .name('backup')
  .description('Create a lossless backup of the knowledge base')
  .requiresEnvironment(true)
  .requiresServices(false)
  .examples(
    'semiont backup --out backup.tar.gz',
  )
  .args({
    args: {
      '--out': {
        type: 'string',
        description: 'Output file path (required)',
      },
    },
    aliases: {},
  })
  .schema(BackupOptionsSchema)
  .handler(runBackup)
  .build();
