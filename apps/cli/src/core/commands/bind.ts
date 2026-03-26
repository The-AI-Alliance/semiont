/**
 * Bind Command
 *
 * Resolves an unresolved linking annotation by adding a SpecificResource
 * body item pointing to the chosen target resource.
 *
 * This is the final step of the gather → match → bind pipeline.
 * Calls PUT /resources/{resourceId}/annotations/{annotationId}/body
 * through SemiontApiClient.
 *
 * Usage:
 *   semiont bind <resourceId> <annotationId> <targetResourceId>
 */

import { z } from 'zod';
import { resourceId as toResourceId, annotationId as toAnnotationId } from '@semiont/core';
import type { components } from '@semiont/core';
import { CommandResults } from '../command-types.js';
import { CommandBuilder } from '../command-definition.js';
import { BaseOptionsSchema, withBaseArgs } from '../base-options-schema.js';
import { printSuccess } from '../io/cli-logger.js';
import { findProjectRoot } from '../config-loader.js';
import { createAuthenticatedClient } from '../api-client-factory.js';

type UpdateAnnotationBodyRequest = components['schemas']['UpdateAnnotationBodyRequest'];

// =====================================================================
// SCHEMA
// =====================================================================

export const BindOptionsSchema = BaseOptionsSchema.extend({
  args: z.array(z.string()).min(3, 'Usage: semiont bind <resourceId> <annotationId> <targetResourceId>').max(3),
});

export type BindOptions = z.output<typeof BindOptionsSchema>;

// =====================================================================
// IMPLEMENTATION
// =====================================================================

export async function runBind(options: BindOptions): Promise<CommandResults> {
  const startTime = Date.now();
  const projectRoot = findProjectRoot();
  const environment = options.environment!;

  const [rawResourceId, rawAnnotationId, targetResourceId] = options.args;
  const resourceId = toResourceId(rawResourceId);
  const annotationId = toAnnotationId(rawAnnotationId);

  const { client, token } = await createAuthenticatedClient(projectRoot, environment);

  const request: UpdateAnnotationBodyRequest = {
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

  await client.bindAnnotation(resourceId, annotationId, request, { auth: token });

  if (!options.quiet) printSuccess(`Bound: ${rawAnnotationId} → ${targetResourceId}`);

  return {
    command: 'bind',
    environment,
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
    ...withBaseArgs({}, {}),
    restAs: 'args',
    aliases: {},
  })
  .schema(BindOptionsSchema)
  .handler(runBind)
  .build();
