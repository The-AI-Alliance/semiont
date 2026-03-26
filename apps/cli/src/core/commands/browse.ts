/**
 * Browse Command
 *
 * Human-readable traversal of the knowledge base. Designed for inspection,
 * scripting, and reporting — not for LLM pipeline consumption (use `semiont gather`
 * for machine-readable context).
 *
 * Usage:
 *   semiont browse resources [--search <query>] [--entity-type <type>] [--limit <n>]
 *   semiont browse resource <resourceId> [--annotations] [--references]
 *   semiont browse annotation <resourceId> <annotationId>
 *   semiont browse references <resourceId>
 *
 * See CLI-BROWSE.md for full design.
 */

import { z } from 'zod';
import { resourceId as toResourceId, annotationId as toAnnotationId } from '@semiont/core';
import { CommandResults } from '../command-types.js';
import { CommandBuilder } from '../command-definition.js';
import { ApiOptionsSchema, withApiArgs } from '../base-options-schema.js';
import { findProjectRoot } from '../config-loader.js';
import { createAuthenticatedClient } from '../api-client-factory.js';

// =====================================================================
// SCHEMA
// =====================================================================

export const BrowseOptionsSchema = ApiOptionsSchema.extend({
  args: z.array(z.string()).min(1, 'Subcommand required: resources | resource | annotation | references | events | history | entity-types'),
  // browse resources options
  search: z.string().optional(),
  entityType: z.array(z.string()).default([]),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  // browse resource options
  annotations: z.boolean().default(false),
  references: z.boolean().default(false),
}).superRefine((val, ctx) => {
  const sub = val.args[0];
  const valid = ['resources', 'resource', 'annotation', 'references', 'events', 'history', 'entity-types'];
  if (!valid.includes(sub)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Unknown subcommand '${sub}'. Valid: ${valid.join(', ')}` });
  }
  if (sub === 'resource' && val.args.length < 2) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Usage: semiont browse resource <resourceId>' });
  }
  if (sub === 'annotation' && val.args.length < 3) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Usage: semiont browse annotation <resourceId> <annotationId>' });
  }
  if (sub === 'references' && val.args.length < 2) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Usage: semiont browse references <resourceId>' });
  }
  if (sub === 'events' && val.args.length < 2) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Usage: semiont browse events <resourceId>' });
  }
  if (sub === 'history' && val.args.length < 3) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Usage: semiont browse history <resourceId> <annotationId>' });
  }
});

export type BrowseOptions = z.output<typeof BrowseOptionsSchema>;

// =====================================================================
// IMPLEMENTATION
// =====================================================================

export async function runBrowse(options: BrowseOptions): Promise<CommandResults> {
  const startTime = Date.now();
  const projectRoot = findProjectRoot();
  const environment = options.environment!;

  const { client, token } = await createAuthenticatedClient(projectRoot, environment, { bus: options.bus, user: options.user, password: options.password });

  const [subcommand, rawResourceId, rawAnnotationId] = options.args;

  let result: unknown;
  let label: string;

  if (subcommand === 'resources') {
    const data = await client.browseResources(
      options.limit,
      undefined,
      options.search as any,
      { auth: token }
    );
    result = data;
    const items = Array.isArray(data) ? data : (data as any)?.resources ?? [];
    label = `${items.length} resource${items.length !== 1 ? 's' : ''} found`;

  } else if (subcommand === 'resource') {
    const id = toResourceId(rawResourceId);
    const resourceData = await client.browseResource(id, { auth: token });

    if (options.annotations || options.references) {
      const annotationsData = await client.browseAnnotations(id, undefined, { auth: token });
      const annotations = (annotationsData as any)?.annotations ?? annotationsData ?? [];

      let referencedBy: unknown[] = [];
      if (options.references) {
        const refData = await client.browseReferences(id, { auth: token });
        referencedBy = refData.referencedBy ?? [];
      }

      result = {
        ...(resourceData as object),
        ...(options.annotations ? { annotations } : {}),
        ...(options.references ? { referencedBy } : {}),
      };
    } else {
      result = resourceData;
    }
    label = `${rawResourceId}: ${(resourceData as any)?.name ?? rawResourceId}`;

  } else if (subcommand === 'annotation') {
    const resourceId = toResourceId(rawResourceId);
    const annotationId = toAnnotationId(rawAnnotationId);
    result = await client.browseAnnotation(resourceId, annotationId, { auth: token });
    label = `${rawAnnotationId}: annotation on ${rawResourceId}`;

  } else if (subcommand === 'references') {
    const id = toResourceId(rawResourceId);
    const data = await client.browseReferences(id, { auth: token });
    result = data.referencedBy ?? [];
    const count = Array.isArray(result) ? result.length : 0;
    label = `${count} resource${count !== 1 ? 's' : ''} reference ${rawResourceId}`;

  } else if (subcommand === 'events') {
    const id = toResourceId(rawResourceId);
    const data = await client.getResourceEvents(id, { auth: token });
    result = data.events ?? data;
    const items = Array.isArray(result) ? result : [];
    label = `${items.length} event${items.length !== 1 ? 's' : ''} for ${rawResourceId}`;

  } else if (subcommand === 'history') {
    const resourceId = toResourceId(rawResourceId);
    const annotationId = toAnnotationId(rawAnnotationId);
    result = await client.getAnnotationHistory(resourceId, annotationId, { auth: token });
    label = `history for annotation ${rawAnnotationId} on ${rawResourceId}`;

  } else {
    // subcommand === 'entity-types'
    result = await client.listEntityTypes({ auth: token });
    const items = Array.isArray(result) ? result : (result as any)?.tags ?? [];
    label = `${items.length} entity type${items.length !== 1 ? 's' : ''}`;
  }

  if (!options.quiet) process.stderr.write(label + '\n');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');

  return {
    command: 'browse',
    environment,
    timestamp: new Date(),
    duration: Date.now() - startTime,
    summary: { succeeded: 1, failed: 0, total: 1, warnings: 0 },
    executionContext: { user: process.env.USER || 'unknown', workingDirectory: process.cwd(), dryRun: options.dryRun },
    results: [{ entity: rawResourceId ?? subcommand, platform: 'posix', success: true, duration: Date.now() - startTime }],
  };
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const browseCmd = new CommandBuilder()
  .name('browse')
  .description(
    'Human-readable traversal of the knowledge base. ' +
    'Subcommands: resources (list), resource <id> (inspect), annotation <resourceId> <annotationId> (inspect), references <id> (who links here), ' +
    'events <resourceId> (historical event log), history <resourceId> <annotationId> (annotation audit trail), entity-types (available entity type catalogue). ' +
    'Outputs JSON to stdout; progress label to stderr. ' +
    'For LLM pipeline consumption use `semiont gather` instead.'
  )
  .requiresEnvironment(true)
  .requiresServices(true)
  .examples(
    'semiont browse resources',
    'semiont browse resources --search "Paris"',
    'semiont browse resources --entity-type Location --limit 20',
    'semiont browse resource <resourceId>',
    'semiont browse resource <resourceId> --annotations',
    'semiont browse resource <resourceId> --references',
    'semiont browse annotation <resourceId> <annotationId>',
    'semiont browse references <resourceId>',
    'semiont browse events <resourceId>',
    'semiont browse history <resourceId> <annotationId>',
    'semiont browse entity-types',
    'semiont browse resources --search "Paris" | jq \'.[]["@id"]\'',
    'semiont browse references <resourceId> | jq \'.[].name\'',
    'semiont browse entity-types | jq \'.[].tag\'',
  )
  .args({
    ...withApiArgs({
      '--search': {
        type: 'string',
        description: 'Filter resources by name or content (browse resources only)',
      },
      '--entity-type': {
        type: 'array',
        description: 'Filter resources by entity type (browse resources only; repeatable)',
      },
      '--limit': {
        type: 'string',
        description: 'Maximum number of results (browse resources only; default: 50)',
      },
      '--annotations': {
        type: 'boolean',
        description: 'Include annotation list in resource output (browse resource only)',
        default: false,
      },
      '--references': {
        type: 'boolean',
        description: 'Include resolved reference targets (browse resource only)',
        default: false,
      },
    }, {}),
    restAs: 'args',
    aliases: {},
  })
  .schema(BrowseOptionsSchema)
  .handler(runBrowse)
  .build();
