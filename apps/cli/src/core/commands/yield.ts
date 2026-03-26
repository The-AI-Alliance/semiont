/**
 * Yield Command
 *
 * Registers one or more files as semiont resources via the live backend.
 * Calls POST /resources (multipart) through SemiontApiClient.
 *
 * Usage:
 *   semiont yield docs/overview.md
 *   semiont yield docs/overview.md --name "Overview Document"
 */

import * as path from 'path';
import { promises as nodeFs } from 'fs';
import { z } from 'zod';
import { CommandResults } from '../command-types.js';
import { CommandBuilder } from '../command-definition.js';
import { BaseOptionsSchema, withBaseArgs } from '../base-options-schema.js';
import { printSuccess, printWarning } from '../io/cli-logger.js';
import { findProjectRoot } from '../config-loader.js';
import { createAuthenticatedClient } from '../api-client-factory.js';

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
});

export type YieldOptions = z.output<typeof YieldOptionsSchema>;

// =====================================================================
// IMPLEMENTATION
// =====================================================================

export async function runYield(options: YieldOptions): Promise<CommandResults> {
  const startTime = Date.now();
  const projectRoot = findProjectRoot();
  const environment = options.environment!;

  if (options.name && options.files.length > 1) {
    throw new Error('--name can only be used when yielding a single file');
  }

  const { client, token } = await createAuthenticatedClient(projectRoot, environment);

  let succeeded = 0;
  let failed = 0;
  const results: CommandResults['results'] = [];

  for (const filePath of options.files) {
    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(projectRoot, filePath);

    const fileStart = Date.now();

    let content: Buffer;
    try {
      content = await nodeFs.readFile(absPath);
    } catch {
      if (!options.quiet) printWarning(`File not found: ${filePath}`);
      results.push({ entity: filePath, platform: 'posix', success: false, metadata: { error: 'File not found' }, duration: 0 });
      failed++;
      continue;
    }

    const relPath = path.relative(projectRoot, absPath).replace(/\\/g, '/');
    const storageUri = `file://${relPath}`;
    const name = options.name ?? path.basename(filePath, path.extname(filePath));
    const format = guessFormat(filePath);

    const { resourceId } = await client.createResource(
      { name, file: content, format, storageUri },
      { auth: token },
    );

    if (!options.quiet) printSuccess(`Yielded: ${filePath} → ${resourceId}`);
    results.push({ entity: filePath, platform: 'posix', success: true, metadata: { resourceId, storageUri }, duration: Date.now() - fileStart });
    succeeded++;
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
  .description('Register files as semiont resources via the live backend')
  .requiresEnvironment(true)
  .requiresServices(true)
  .examples(
    'semiont yield docs/overview.md',
    'semiont yield docs/new.md --name "Overview Document"',
  )
  .args({
    ...withBaseArgs({
      '--name': {
        type: 'string',
        description: 'Resource name (only valid for a single file)',
      },
    }, {
      '-n': '--name',
    }),
    restAs: 'files',
  })
  .schema(YieldOptionsSchema)
  .handler(runYield)
  .build();
