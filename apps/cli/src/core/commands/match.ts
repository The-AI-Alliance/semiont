/**
 * Match Command
 *
 * Searches for binding candidates for an annotation.
 *
 * Two-step process:
 *   1. semiont.gather.annotation → GatheredContext
 *   2. semiont.match.search → scored ResourceDescriptor[]
 *
 * Usage:
 *   semiont match <resourceId> <annotationId> [options]
 */

import { z } from 'zod';
import { firstValueFrom, lastValueFrom } from 'rxjs';
import { resourceId as toResourceId, annotationId as toAnnotationId } from '@semiont/core';
import type { components, GatheredContext } from '@semiont/core';
import { CommandResults } from '../command-types.js';
import { CommandBuilder } from '../command-definition.js';
import { ApiOptionsSchema, withApiArgs } from '../base-options-schema.js';

import { loadCachedClient, resolveBusUrl } from '../api-client-factory.js';

type ScoredResult = components['schemas']['ResourceDescriptor'] & {
  score?: number;
  matchReason?: string;
};

// =====================================================================
// SCHEMA
// =====================================================================

export const MatchOptionsSchema = ApiOptionsSchema.extend({
  args: z.array(z.string()).min(2, 'Usage: semiont match <resourceId> <annotationId>').max(2),
  contextWindow: z.coerce.number().int().min(100).max(5000).default(1000),
  userHint: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(20).default(10),
  noSemantic: z.boolean().default(false),
});

export type MatchOptions = z.output<typeof MatchOptionsSchema>;

// =====================================================================
// IMPLEMENTATION
// =====================================================================

export async function runMatch(options: MatchOptions): Promise<CommandResults> {
  const startTime = Date.now();

  const [rawResourceId, rawAnnotationId] = options.args;
  const resourceId = toResourceId(rawResourceId);
  const annotationId = toAnnotationId(rawAnnotationId);

  const rawBusUrl = resolveBusUrl(options.bus);
  const { semiont } = loadCachedClient(rawBusUrl);

  // Step 1: gather context
  let context = await lastValueFrom(
    semiont.gather.annotation(annotationId, resourceId, { contextWindow: options.contextWindow }),
  ) as GatheredContext;

  if (options.userHint) {
    context = { ...context, userHint: options.userHint };
  }

  // Step 2: search via namespace (MatchVM is EventBus-driven, CLI calls directly)
  const searchResult = await firstValueFrom(
    semiont.match.search(resourceId, rawAnnotationId, context, {
      limit: options.limit,
      useSemanticScoring: !options.noSemantic,
    }),
  );

  const results = (searchResult as any).response as ScoredResult[];

  process.stdout.write(JSON.stringify(results, null, 2));
  if (!options.quiet) process.stdout.write('\n');

  return {
    command: 'match',
    environment: rawBusUrl,
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
  .description('Search for binding candidates for an annotation. Gathers context, then runs scored search.')
  .requiresEnvironment(true)
  .requiresServices(true)
  .examples(
    'semiont match <resourceId> <annotationId>',
    'semiont match <resourceId> <annotationId> --limit 5 --no-semantic',
    'semiont match <resourceId> <annotationId> --user-hint "quantum physics" --context-window 2000',
  )
  .args({
    ...withApiArgs({
      'context-window': { type: 'number', description: 'Char window around annotation (100-5000)', default: '1000' },
      'user-hint': { type: 'string', description: 'Additional search hint' },
      limit: { type: 'number', description: 'Max results (1-20)', default: '10' },
      'no-semantic': { type: 'boolean', description: 'Disable semantic scoring' },
    }, {
      'context-window': 'contextWindow',
      'user-hint': 'userHint',
      limit: 'limit',
      'no-semantic': 'noSemantic',
    }),
    restAs: 'args',
    aliases: {},
  })
  .schema(MatchOptionsSchema)
  .handler(runMatch)
  .build();
