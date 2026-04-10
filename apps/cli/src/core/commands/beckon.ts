/**
 * Beckon Command
 *
 * Directs a participant's attention to a specific resource or annotation.
 * Produces no annotations, bindings, or persistent state — attention only.
 *
 * Usage:
 *   semiont beckon <participantId> --resource <resourceId>
 *   semiont beckon <participantId> --resource <resourceId> --annotation <annotationId>
 *   semiont beckon <participantId> --resource <resourceId> --annotation <annotationId> \
 *     --message "This linking annotation needs manual review"
 *
 * The participant can be a human username or an agent identifier — beckon does not
 * distinguish between them. The same call that notifies a human reviewer also wakes
 * a waiting agent process polling its attention queue.
 *
 * See CLI-BECKON.md for full design.
 */

import { z } from 'zod';
import { CommandResults } from '../command-types.js';
import { CommandBuilder } from '../command-definition.js';
import { ApiOptionsSchema, withApiArgs } from '../base-options-schema.js';

import { loadCachedClient, resolveBusUrl } from '../api-client-factory.js';

// =====================================================================
// SCHEMA
// =====================================================================

export const BeckonOptionsSchema = ApiOptionsSchema.extend({
  participantArr: z.array(z.string()).min(1, 'participantId is required').max(1, 'Only one participant per beckon'),
  resource: z.string({ required_error: '--resource <resourceId> is required' }),
  annotation: z.string().optional(),
  message: z.string().max(500).optional(),
});

export type BeckonOptions = z.output<typeof BeckonOptionsSchema>;

// =====================================================================
// IMPLEMENTATION
// =====================================================================

export async function runBeckon(options: BeckonOptions): Promise<CommandResults> {
  const startTime = Date.now();
  

  const rawBusUrl = resolveBusUrl(options.bus);
  const { semiont, token } = loadCachedClient(rawBusUrl);

  const [participantId] = options.participantArr;

  const result = await semiont.beckonAttention(
    participantId,
    {
      resourceId: options.resource,
      ...(options.annotation ? { annotationId: options.annotation } : {}),
      ...(options.message ? { message: options.message } : {}),
    },
    { auth: token }
  );

  if (!options.quiet) {
    const target = options.annotation
      ? `${options.resource} (${options.annotation})`
      : options.resource;
    process.stderr.write(`Beckoned ${participantId} → ${target}\n`);
  }
  process.stdout.write(JSON.stringify(result) + '\n');

  return {
    command: 'beckon',
    environment: rawBusUrl,
    timestamp: new Date(),
    duration: Date.now() - startTime,
    summary: { succeeded: 1, failed: 0, total: 1, warnings: 0 },
    executionContext: { user: process.env.USER || 'unknown', workingDirectory: process.cwd(), dryRun: options.dryRun },
    results: [{ entity: participantId, platform: 'posix', success: true, duration: Date.now() - startTime }],
  };
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const beckonCmd = new CommandBuilder()
  .name('beckon')
  .description(
    'Direct a participant\'s attention to a resource or annotation. ' +
    'Produces no persistent state — attention signal only. ' +
    'The participant may be a human username or an agent identifier.'
  )
  .requiresEnvironment(true)
  .requiresServices(true)
  .examples(
    'semiont beckon alice --resource <resourceId>',
    'semiont beckon alice --resource <resourceId> --annotation <annotationId>',
    'semiont beckon alice --resource <resourceId> --annotation <annotationId> --message "Needs manual review"',
    'semiont beckon my-review-agent --resource <resourceId> --annotation <annotationId>',
  )
  .args({
    ...withApiArgs({
      '--resource': {
        type: 'string',
        description: 'Resource to direct attention at (required)',
        required: true,
      },
      '--annotation': {
        type: 'string',
        description: 'Specific annotation within the resource (optional)',
      },
      '--message': {
        type: 'string',
        description: 'Human-readable context for the participant (max 500 chars)',
      },
    }, {}),
    restAs: 'participantArr',
    aliases: {},
  })
  .schema(BeckonOptionsSchema)
  .handler(runBeckon)
  .build();
