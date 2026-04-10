/**
 * Gather Command
 *
 * Fetches LLM-optimized context for a resource or annotation.
 *
 * Usage:
 *   semiont gather resource <resourceId> [options]
 *   semiont gather annotation <resourceId> <annotationId> [options]
 */

import { z } from 'zod';
import { firstValueFrom } from 'rxjs';
import { filter, take, timeout } from 'rxjs/operators';
import { resourceId as toResourceId, annotationId as toAnnotationId } from '@semiont/core';
import { CommandResults } from '../command-types.js';
import { CommandBuilder } from '../command-definition.js';
import { ApiOptionsSchema, withApiArgs } from '../base-options-schema.js';

import { loadCachedClient, resolveBusUrl } from '../api-client-factory.js';

// =====================================================================
// SCHEMA
// =====================================================================

export const GatherOptionsSchema = ApiOptionsSchema.extend({
  args: z.array(z.string()).min(2, 'Usage: semiont gather resource <resourceId> | gather annotation <resourceId> <annotationId>'),
  depth: z.coerce.number().int().min(1).max(3).default(2),
  maxResources: z.coerce.number().int().min(1).max(20).default(10),
  noContent: z.boolean().default(false),
  summary: z.boolean().default(false),
  contextWindow: z.coerce.number().int().min(100).max(5000).default(1000),
});

export type GatherOptions = z.output<typeof GatherOptionsSchema>;

// =====================================================================
// IMPLEMENTATION
// =====================================================================

export async function runGather(options: GatherOptions): Promise<CommandResults> {
  const startTime = Date.now();
  const rawBusUrl = resolveBusUrl(options.bus);
  const { client } = loadCachedClient(rawBusUrl);

  const [subcommand, rawResourceId, rawAnnotationId] = options.args;

  let result: unknown;

  if (subcommand === 'resource') {
    const id = toResourceId(rawResourceId);
    result = await client.gather.resource(id, { contextWindow: options.contextWindow });
  } else if (subcommand === 'annotation') {
    if (!rawAnnotationId) {
      throw new Error('Usage: semiont gather annotation <resourceId> <annotationId>');
    }
    const resourceId = toResourceId(rawResourceId);
    const annotationId = toAnnotationId(rawAnnotationId);

    // gather.annotation returns Observable — await the completion event
    const completion = await firstValueFrom(
      client.gather.annotation(annotationId, resourceId, { contextWindow: options.contextWindow }).pipe(
        filter((e): e is Extract<typeof e, { response: unknown }> => 'response' in e),
        take(1),
        timeout(60_000),
      ),
    );
    result = (completion as any).response;
  } else {
    throw new Error(`Unknown subcommand: ${subcommand}. Use 'resource' or 'annotation'.`);
  }

  process.stdout.write(JSON.stringify(result, null, 2));
  if (!options.quiet) process.stdout.write('\n');

  return {
    command: 'gather',
    environment: rawBusUrl,
    timestamp: new Date(),
    duration: Date.now() - startTime,
    summary: { succeeded: 1, failed: 0, total: 1, warnings: 0 },
    executionContext: { user: process.env.USER || 'unknown', workingDirectory: process.cwd(), dryRun: options.dryRun },
    results: [{ entity: rawResourceId, platform: 'posix', success: true, duration: Date.now() - startTime }],
  };
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const gatherCmd = new CommandBuilder()
  .name('gather')
  .description('Fetch LLM-optimized context for a resource or annotation.')
  .requiresEnvironment(true)
  .requiresServices(true)
  .examples(
    'semiont gather resource <resourceId>',
    'semiont gather annotation <resourceId> <annotationId>',
    'semiont gather resource <resourceId> --depth 3 --max-resources 15',
    'semiont gather annotation <resourceId> <annotationId> --context-window 2000',
  )
  .args({
    ...withApiArgs({
      depth: { type: 'number', description: 'Graph traversal depth (1-3)', default: '2' },
      'max-resources': { type: 'number', description: 'Maximum related resources (1-20)', default: '10' },
      'no-content': { type: 'boolean', description: 'Exclude resource content from context' },
      summary: { type: 'boolean', description: 'Include AI-generated summaries' },
      'context-window': { type: 'number', description: 'Character window around annotation (100-5000)', default: '1000' },
    }, {
      depth: 'depth',
      'max-resources': 'maxResources',
      'no-content': 'noContent',
      summary: 'summary',
      'context-window': 'contextWindow',
    }),
    restAs: 'args',
    aliases: {},
  })
  .schema(GatherOptionsSchema)
  .handler(runGather)
  .build();
