/**
 * Gather Command
 *
 * Fetches LLM-optimized context for a resource or annotation via SSE stream.
 *
 * Usage:
 *   semiont gather resource <resourceId> [options]
 *   semiont gather annotation <resourceId> <annotationId> [options]
 */

import { z } from 'zod';
import { resourceId as toResourceId, annotationId as toAnnotationId, EventBus } from '@semiont/core';
import type { components } from '@semiont/core';
import { CommandResults } from '../command-types.js';
import { CommandBuilder } from '../command-definition.js';
import { ApiOptionsSchema, withApiArgs } from '../base-options-schema.js';

import { loadCachedClient, resolveBusUrl } from '../api-client-factory.js';

// =====================================================================
// SCHEMA
// =====================================================================

export const GatherOptionsSchema = ApiOptionsSchema.extend({
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

function waitForGatherResourceFinished(eventBus: EventBus): Promise<components['schemas']['ResourceLLMContextResponse']> {
  return new Promise((resolve, reject) => {
    const doneSub = eventBus.get('gather:finished').subscribe((event) => {
      doneSub.unsubscribe();
      failSub.unsubscribe();
      resolve(event.response);
    });
    const failSub = eventBus.get('gather:failed').subscribe((event: any) => {
      doneSub.unsubscribe();
      failSub.unsubscribe();
      reject(event.error ?? new Error('Gather resource failed'));
    });
  });
}

function waitForGatherAnnotationFinished(eventBus: EventBus): Promise<components['schemas']['AnnotationLLMContextResponse']> {
  return new Promise((resolve, reject) => {
    const doneSub = eventBus.get('gather:annotation-finished').subscribe((event) => {
      doneSub.unsubscribe();
      failSub.unsubscribe();
      resolve(event.response);
    });
    const failSub = eventBus.get('gather:failed').subscribe((event: any) => {
      doneSub.unsubscribe();
      failSub.unsubscribe();
      reject(event.error ?? new Error('Gather annotation failed'));
    });
  });
}

export async function runGather(options: GatherOptions): Promise<CommandResults> {
  const startTime = Date.now();
  const rawBusUrl = resolveBusUrl(options.bus);
  const { client, token } = loadCachedClient(rawBusUrl);

  const [subcommand, rawResourceId, rawAnnotationId] = options.args;

  let result: unknown;

  if (subcommand === 'resource') {
    const id = toResourceId(rawResourceId);
    const eventBus = new EventBus();
    const donePromise = waitForGatherResourceFinished(eventBus);
    client.sse.gatherResource(
      id,
      {
        depth: options.depth,
        maxResources: options.maxResources,
        includeContent: !options.noContent,
        includeSummary: options.summary,
      },
      { auth: token, eventBus },
    );
    result = await donePromise;
  } else if (subcommand === 'annotation') {
    if (!rawAnnotationId) {
      throw new Error('Usage: semiont gather annotation <resourceId> <annotationId>');
    }
    const resourceId = toResourceId(rawResourceId);
    const annotationId = toAnnotationId(rawAnnotationId);
    const eventBus = new EventBus();
    const donePromise = waitForGatherAnnotationFinished(eventBus);
    client.sse.gatherAnnotation(
      resourceId,
      annotationId,
      { contextWindow: options.contextWindow },
      { auth: token, eventBus },
    );
    result = await donePromise;
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
    ...withApiArgs({
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
