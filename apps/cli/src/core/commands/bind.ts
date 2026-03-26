/**
 * Bind Command
 *
 * Resolves an unresolved linking annotation by adding a SpecificResource
 * body item pointing to the chosen target resource.
 *
 * This is the final step of the gather → match → bind pipeline.
 * Streams completion via SSE through client.sse.bindAnnotation().
 *
 * Usage:
 *   semiont bind <resourceId> <annotationId> <targetResourceId>
 */

import { z } from 'zod';
import { resourceId as toResourceId, annotationId as toAnnotationId, EventBus } from '@semiont/core';
import type { components } from '@semiont/core';
import { CommandResults } from '../command-types.js';
import { CommandBuilder } from '../command-definition.js';
import { ApiOptionsSchema, withApiArgs } from '../base-options-schema.js';
import { printSuccess } from '../io/cli-logger.js';

import { loadCachedClient, resolveBusUrl } from '../api-client-factory.js';

type BindAnnotationStreamRequest = components['schemas']['BindAnnotationStreamRequest'];

// =====================================================================
// SCHEMA
// =====================================================================

export const BindOptionsSchema = ApiOptionsSchema.extend({
  args: z.array(z.string()).min(3, 'Usage: semiont bind <resourceId> <annotationId> <targetResourceId>').max(3),
});

export type BindOptions = z.output<typeof BindOptionsSchema>;

// =====================================================================
// IMPLEMENTATION
// =====================================================================

function waitForBindFinished(eventBus: EventBus): Promise<void> {
  return new Promise((resolve, reject) => {
    const doneSub = eventBus.get('bind:finished').subscribe(() => {
      doneSub.unsubscribe();
      failSub.unsubscribe();
      resolve();
    });
    const failSub = eventBus.get('bind:failed').subscribe((event: any) => {
      doneSub.unsubscribe();
      failSub.unsubscribe();
      reject(event.error ?? new Error('Bind failed'));
    });
  });
}

export async function runBind(options: BindOptions): Promise<CommandResults> {
  const startTime = Date.now();
  const rawBusUrl = resolveBusUrl(options.bus);
  const { client, token } = loadCachedClient(rawBusUrl);

  const [rawResourceId, rawAnnotationId, targetResourceId] = options.args;
  const resourceId = toResourceId(rawResourceId);
  const annotationId = toAnnotationId(rawAnnotationId);

  const request: BindAnnotationStreamRequest = {
    resourceId: rawResourceId,
    operations: [{
      op: 'add',
      item: {
        type: 'SpecificResource',
        source: targetResourceId,
        purpose: 'linking',
      },
    }],
  };

  const eventBus = new EventBus();
  const donePromise = waitForBindFinished(eventBus);
  client.sse.bindAnnotation(resourceId, annotationId, request, { auth: token, eventBus });
  await donePromise;

  if (!options.quiet) printSuccess(`Bound: ${rawAnnotationId} → ${targetResourceId}`);

  return {
    command: 'bind',
    environment: rawBusUrl,
    timestamp: new Date(),
    duration: Date.now() - startTime,
    summary: { succeeded: 1, failed: 0, total: 1, warnings: 0 },
    executionContext: { user: process.env.USER || 'unknown', workingDirectory: process.cwd(), dryRun: options.dryRun },
    results: [{ entity: rawAnnotationId, platform: 'posix', success: true, metadata: { targetResourceId }, duration: Date.now() - startTime }],
  };
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const bindCmd = new CommandBuilder()
  .name('bind')
  .description('Resolve a linking annotation to a target resource. Adds a SpecificResource body item (purpose: linking) via PUT /resources/{resourceId}/annotations/{annotationId}/body.')
  .requiresEnvironment(true)
  .requiresServices(true)
  .examples(
    'semiont bind <resourceId> <annotationId> <targetResourceId>',
    'TARGET=$(semiont match <resourceId> <annotationId> --quiet | jq -r \'.[0]["@id"]\') && semiont bind <resourceId> <annotationId> "$TARGET"',
  )
  .args({
    ...withApiArgs({}, {}),
    restAs: 'args',
    aliases: {},
  })
  .schema(BindOptionsSchema)
  .handler(runBind)
  .build();
