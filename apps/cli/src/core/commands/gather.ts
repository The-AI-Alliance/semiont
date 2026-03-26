/**
 * Gather Command
 *
 * Fetches LLM-optimized context for a resource or annotation via SemiontApiClient.
 *
 * Usage:
 *   semiont gather resource <resourceId> [options]
 *   semiont gather annotation <resourceId> <annotationId> [options]
 */

import { z } from 'zod';
import { resourceId as toResourceId, annotationId as toAnnotationId } from '@semiont/core';
import { CommandResults } from '../command-types.js';
import { CommandBuilder } from '../command-definition.js';
import { BaseOptionsSchema, withBaseArgs } from '../base-options-schema.js';
import { findProjectRoot } from '../config-loader.js';
import { createAuthenticatedClient } from '../api-client-factory.js';

// =====================================================================
// SCHEMA
// =====================================================================

export const GatherOptionsSchema = BaseOptionsSchema.extend({
  args: z.array(z.string()).min(2, 'Usage: semiont gather resource <resourceId> | gather annotation <resourceId> <annotationId>'),
  // resource options
  depth: z.coerce.number().int().min(1).max(3).default(2),
  maxResources: z.coerce.number().int().min(1).max(20).default(10),
  noContent: z.boolean().default(false),
  summary: z.boolean().default(false),
  // annotation options
  contextWindow: z.coerce.number().int().min(100).max(5000).default(1000),
});

export type GatherOptions = z.output<typeof GatherOptionsSchema>;

// =====================================================================
// IMPLEMENTATION
// =====================================================================

export async function runGather(options: GatherOptions): Promise<CommandResults> {
  const startTime = Date.now();
  const projectRoot = findProjectRoot();
  const environment = options.environment!;

  const [subcommand, rawResourceId, rawAnnotationId] = options.args;

  const { client, token } = await createAuthenticatedClient(projectRoot, environment);

  let result: unknown;

  if (subcommand === 'resource') {
    const id = toResourceId(rawResourceId);
    result = await client.getResourceLLMContext(id, {
      depth: options.depth,
      maxResources: options.maxResources,
      includeContent: !options.noContent,
      includeSummary: options.summary,
      auth: token,
    });
  } else if (subcommand === 'annotation') {
    if (!rawAnnotationId) {
      throw new Error('Usage: semiont gather annotation <resourceId> <annotationId>');
    }
    const resourceId = toResourceId(rawResourceId);
    const annotationId = toAnnotationId(rawAnnotationId);
    result = await client.getAnnotationLLMContext(resourceId, annotationId, {
      contextWindow: options.contextWindow,
      auth: token,
    });
  } else {
    throw new Error(`Unknown subcommand: ${subcommand}. Use 'resource' or 'annotation'.`);
  }

  process.stdout.write(JSON.stringify(result, null, 2));
  if (!options.quiet) process.stdout.write('\n');

  return {
    command: 'gather',
    environment,
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
  .description('Fetch LLM-optimized context for a resource or annotation. Outputs JSON to stdout: ResourceLLMContextResponse (resource) or AnnotationLLMContextResponse containing GatheredContext (annotation). Schemas defined in specs/src/components/schemas/.')
  .requiresEnvironment(true)
  .requiresServices(true)
  .examples(
    'semiont gather resource <resourceId>',
    'semiont gather resource <resourceId> --depth 3 --max-resources 20',
    'semiont gather resource <resourceId> --no-content',
    'semiont gather annotation <resourceId> <annotationId>',
    'semiont gather annotation <resourceId> <annotationId> --context-window 200',
    'semiont gather resource <resourceId> | jq \'.mainResource.name\'',
    'semiont gather annotation <resourceId> <annotationId> | jq \'.context.sourceContext.selected\'',
  )
  .args({
    ...withBaseArgs({
      '--depth': {
        type: 'string',
        description: 'Graph traversal depth: 1–3 (default: 2)',
      },
      '--max-resources': {
        type: 'string',
        description: 'Max related resources to include: 1–20 (default: 10)',
      },
      '--no-content': {
        type: 'boolean',
        description: 'Exclude full resource content (default: content included)',
        default: false,
      },
      '--summary': {
        type: 'boolean',
        description: 'Request AI-generated summary (default: false)',
        default: false,
      },
      '--context-window': {
        type: 'string',
        description: 'Characters of surrounding text context: 100–5000 (default: 1000)',
      },
    }, {}),
    restAs: 'args',
    aliases: {},
  })
  .schema(GatherOptionsSchema)
  .handler(runGather)
  .build();
