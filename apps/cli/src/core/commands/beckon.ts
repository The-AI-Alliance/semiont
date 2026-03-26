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
 * See CLI-BECKON.md for full design and backend prerequisites.
 *
 * NOTE: This command requires a backend attention endpoint
 * (POST /participants/{id}/attention) that is not yet implemented.
 * The command is registered and validates its arguments but will
 * fail at runtime until the backend endpoint exists.
 */

import { z } from 'zod';
import { CommandResults } from '../command-types.js';
import { CommandBuilder } from '../command-definition.js';
import { BaseOptionsSchema, withBaseArgs } from '../base-options-schema.js';

// =====================================================================
// SCHEMA
// =====================================================================

export const BeckonOptionsSchema = BaseOptionsSchema.extend({
  participantArr: z.array(z.string()).min(1, 'participantId is required').max(1, 'Only one participant per beckon'),
  resource: z.string({ required_error: '--resource <resourceId> is required' }),
  annotation: z.string().optional(),
  message: z.string().max(500).optional(),
});

export type BeckonOptions = z.output<typeof BeckonOptionsSchema>;

// =====================================================================
// IMPLEMENTATION
// =====================================================================

export async function runBeckon(_options: BeckonOptions): Promise<CommandResults> {
  // Backend prerequisite not yet implemented.
  // See CLI-BECKON.md — requires POST /participants/{id}/attention endpoint.
  throw new Error(
    'semiont beckon is not yet implemented: the backend attention endpoint ' +
    '(POST /participants/{id}/attention) does not exist yet. See CLI-BECKON.md.'
  );
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const beckonCmd = new CommandBuilder()
  .name('beckon')
  .description(
    'Direct a participant\'s attention to a resource or annotation. ' +
    'Produces no persistent state — attention signal only. ' +
    'The participant may be a human username or an agent identifier. ' +
    'NOTE: requires a backend attention endpoint not yet implemented (see CLI-BECKON.md).'
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
    ...withBaseArgs({
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
