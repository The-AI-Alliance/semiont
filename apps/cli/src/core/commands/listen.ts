/**
 * Listen Command
 *
 * Subscribes to the bus gateway and prints domain events to stdout as
 * newline-delimited JSON (one event per line). Runs until the user presses
 * Ctrl-C or the server closes the connection.
 *
 * Usage:
 *   semiont listen                           — global system events
 *   semiont listen resource <resourceId>     — events scoped to one resource
 */

import { z } from 'zod';
import { resourceId as toResourceId, type PersistedEventType } from '@semiont/core';
import { createActorVM } from '@semiont/api-client';
import type { CommandResults } from '../command-types.js';
import { CommandBuilder } from '../command-definition.js';
import { ApiOptionsSchema, withApiArgs } from '../base-options-schema.js';

import { loadCachedClient, resolveBusUrl } from '../api-client-factory.js';

// =====================================================================
// SCHEMA
// =====================================================================

export const ListenOptionsSchema = ApiOptionsSchema.extend({
  args: z.array(z.string()).default([]),
}).superRefine((val, ctx) => {
  const sub = val.args[0];
  if (sub !== undefined && sub !== 'resource') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Unknown subcommand '${sub}'. Usage: semiont listen [resource <resourceId>]` });
  }
  if (sub === 'resource' && val.args.length < 2) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Usage: semiont listen resource <resourceId>' });
  }
});

export type ListenOptions = z.output<typeof ListenOptionsSchema>;

// =====================================================================
// IMPLEMENTATION
// =====================================================================

const ALL_EVENT_TYPES: PersistedEventType[] = [
  'yield:created', 'yield:cloned', 'yield:updated', 'yield:moved',
  'yield:representation-added', 'yield:representation-removed',
  'mark:added', 'mark:removed', 'mark:body-updated',
  'mark:archived', 'mark:unarchived',
  'mark:entity-tag-added', 'mark:entity-tag-removed',
  'mark:entity-type-added',
  'job:started', 'job:progress', 'job:completed', 'job:failed',
];

export async function runListen(options: ListenOptions): Promise<CommandResults> {
  const startTime = Date.now();

  const rawBusUrl = resolveBusUrl(options.bus);
  const { token } = loadCachedClient(rawBusUrl);

  const [subcommand, rawResourceId] = options.args;
  const isResourceScoped = subcommand === 'resource';

  let eventCount = 0;

  const label = isResourceScoped
    ? `Listening for events on resource ${rawResourceId}`
    : 'Listening for global events';

  if (!options.quiet) process.stderr.write(label + ' (Ctrl-C to stop)\n');

  const actor = createActorVM({
    baseUrl: rawBusUrl,
    token,
    channels: isResourceScoped ? [] : [...ALL_EVENT_TYPES],
  });

  if (isResourceScoped) {
    actor.addChannels([...ALL_EVENT_TYPES], toResourceId(rawResourceId) as string);
  }

  for (const eventType of ALL_EVENT_TYPES) {
    actor.on$(eventType).subscribe((event) => {
      eventCount++;
      process.stdout.write(JSON.stringify(event) + '\n');
    });
  }

  actor.start();

  await new Promise<void>((resolve) => {
    const cleanup = () => {
      actor.dispose();
      resolve();
    };
    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);
  });

  return {
    command: 'listen',
    environment: rawBusUrl,
    timestamp: new Date(),
    duration: Date.now() - startTime,
    summary: { succeeded: eventCount, failed: 0, total: eventCount, warnings: 0 },
    executionContext: { user: process.env.USER || 'unknown', workingDirectory: process.cwd(), dryRun: options.dryRun },
  } as CommandResults;
}

// =====================================================================
// COMMAND
// =====================================================================

export const listenCmd = new CommandBuilder()
  .name('listen')
  .description('Subscribe to real-time domain events from the knowledge base')
  .requiresEnvironment(true)
  .requiresServices(true)
  .examples(
    'semiont listen',
    'semiont listen resource <resourceId>',
  )
  .args({ ...withApiArgs({}, {}), restAs: 'args', aliases: {} })
  .schema(ListenOptionsSchema)
  .handler(runListen)
  .build();
