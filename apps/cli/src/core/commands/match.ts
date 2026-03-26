/**
 * Match Command
 *
 * Searches for binding candidates for an annotation using the same backend
 * flow as the "Search" button in the Gather Context modal.
 *
 * Two-step process:
 *   1. gatherAnnotation → GatheredContext
 *   2. sse.bindSearch (SSE stream) → scored ResourceDescriptor[]
 *
 * Usage:
 *   semiont match <resourceId> <annotationId> [options]
 */

import { z } from 'zod';
import { resourceId as toResourceId, annotationId as toAnnotationId, EventBus } from '@semiont/core';
import type { components, GatheredContext } from '@semiont/core';
import { CommandResults } from '../command-types.js';
import { CommandBuilder } from '../command-definition.js';
import { BaseOptionsSchema, withBaseArgs } from '../base-options-schema.js';
import { findProjectRoot } from '../config-loader.js';
import { createAuthenticatedClient } from '../api-client-factory.js';
import type { SemiontApiClient } from '@semiont/api-client';
import type { AccessToken } from '@semiont/core';

type ScoredResult = components['schemas']['ResourceDescriptor'] & {
  score?: number;
  matchReason?: string;
};

// =====================================================================
// SCHEMA
// =====================================================================

export const MatchOptionsSchema = BaseOptionsSchema.extend({
  args: z.array(z.string()).min(2, 'Usage: semiont match <resourceId> <annotationId>').max(2),
  contextWindow: z.coerce.number().int().min(100).max(5000).default(1000),
  userHint: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(20).default(10),
  noSemantic: z.boolean().default(false),
});

export type MatchOptions = z.output<typeof MatchOptionsSchema>;

// =====================================================================
// HELPERS
// =====================================================================

function waitForSearchResults(eventBus: EventBus, referenceId: string): Promise<ScoredResult[]> {
  return new Promise((resolve, reject) => {
    const resultSub = eventBus.get('bind:search-results').subscribe((event) => {
      if (event.referenceId === referenceId) {
        resultSub.unsubscribe();
        errorSub.unsubscribe();
        resolve(event.results as ScoredResult[]);
      }
    });
    const errorSub = eventBus.get('bind:search-failed').subscribe((event) => {
      if (event.referenceId === referenceId) {
        resultSub.unsubscribe();
        errorSub.unsubscribe();
        reject(event.error);
      }
    });
  });
}

async function gatherContext(
  client: SemiontApiClient,
  resourceId: ReturnType<typeof toResourceId>,
  annotationId: ReturnType<typeof toAnnotationId>,
  contextWindow: number,
  token: AccessToken,
): Promise<GatheredContext> {
  const response = await client.gatherAnnotation(resourceId, annotationId, {
    contextWindow,
    auth: token,
  });
  const context = (response as any).context as GatheredContext | undefined;
  if (!context) {
    throw new Error('No context returned from gatherAnnotation');
  }
  return context;
}

// =====================================================================
// IMPLEMENTATION
// =====================================================================

export async function runMatch(options: MatchOptions): Promise<CommandResults> {
  const startTime = Date.now();
  const projectRoot = findProjectRoot();
  const environment = options.environment!;

  const [rawResourceId, rawAnnotationId] = options.args;
  const resourceId = toResourceId(rawResourceId);
  const annotationId = toAnnotationId(rawAnnotationId);

  const { client, token } = await createAuthenticatedClient(projectRoot, environment);

  // Step 1: gather context
  let context = await gatherContext(client, resourceId, annotationId, options.contextWindow, token);

  // Apply user hint if provided
  if (options.userHint) {
    context = { ...context, userHint: options.userHint };
  }

  // Step 2: search via SSE stream
  const eventBus = new EventBus();
  const resultsPromise = waitForSearchResults(eventBus, rawAnnotationId);

  client.sse.bindSearch(
    resourceId,
    {
      referenceId: rawAnnotationId,
      context,
      limit: options.limit,
      useSemanticScoring: !options.noSemantic,
    },
    { auth: token, eventBus },
  );

  const results = await resultsPromise;

  process.stdout.write(JSON.stringify(results, null, 2));
  if (!options.quiet) process.stdout.write('\n');

  return {
    command: 'match',
    environment,
    timestamp: new Date(),
    duration: Date.now() - startTime,
    summary: { succeeded: 1, failed: 0, total: 1, warnings: 0 },
    executionContext: { user: process.env.USER || 'unknown', workingDirectory: process.cwd(), dryRun: options.dryRun },
    results: [{ entity: rawAnnotationId, platform: 'posix', success: true, metadata: { resultCount: results.length }, duration: Date.now() - startTime }],
  };
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const matchCmd = new CommandBuilder()
  .name('match')
  .description('Search for binding candidates for an annotation. Outputs JSON array of ResourceDescriptor & { score?, matchReason? } to stdout. Uses the same flow as the Search button in the Gather Context modal.')
  .requiresEnvironment(true)
  .requiresServices(true)
  .examples(
    'semiont match <resourceId> <annotationId>',
    'semiont match <resourceId> <annotationId> --user-hint "look for papers about neural scaling"',
    'semiont match <resourceId> <annotationId> --limit 5 --no-semantic',
    'semiont match <resourceId> <annotationId> | jq \'.[0].name\'',
    'semiont match <resourceId> <annotationId> | jq -r \'.[0]["@id"]\' | xargs -I{} semiont mark <resourceId> --motivation linking --link {}',
  )
  .args({
    ...withBaseArgs({
      '--context-window': {
        type: 'string',
        description: 'Characters of context around annotation: 100–5000 (default: 1000)',
      },
      '--user-hint': {
        type: 'string',
        description: 'Override/supplement the context text used for matching',
      },
      '--limit': {
        type: 'string',
        description: 'Max results to return: 1–20 (default: 10)',
      },
      '--no-semantic': {
        type: 'boolean',
        description: 'Disable semantic scoring (faster, keyword-only)',
        default: false,
      },
    }, {}),
    restAs: 'args',
    aliases: {},
  })
  .schema(MatchOptionsSchema)
  .handler(runMatch)
  .build();
