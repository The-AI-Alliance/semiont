/**
 * Listen Command
 *
 * Opens a persistent SSE connection and prints domain events to stdout as
 * newline-delimited JSON (one event per line). Runs until the user presses
 * Ctrl-C or the server closes the connection.
 *
 * Usage:
 *   semiont listen                           — global system events
 *   semiont listen resource <resourceId>     — events scoped to one resource
 */

import { z } from 'zod';
import { resourceId as toResourceId, EventBus, type PersistedEventType } from '@semiont/core';
import { CommandResults } from '../command-types.js';
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

export async function runListen(options: ListenOptions): Promise<CommandResults> {
  const startTime = Date.now();
  

  const rawBusUrl = resolveBusUrl(options.bus);
  const { client, token } = loadCachedClient(rawBusUrl);

  const [subcommand, rawResourceId] = options.args;
  const isResourceScoped = subcommand === 'resource';

  const eventBus = new EventBus();
  let eventCount = 0;

  // Print every domain event as NDJSON — subscribe to all event types
  const allEventTypes: PersistedEventType[] = [
    'yield:created', 'yield:cloned', 'yield:updated', 'yield:moved',
    'yield:representation-added', 'yield:representation-removed',
    'mark:added', 'mark:removed', 'mark:body-updated',
    'mark:archived', 'mark:unarchived',
    'mark:entity-tag-added', 'mark:entity-tag-removed',
    'mark:entity-type-added',
    'job:started', 'job:progress', 'job:completed', 'job:failed',
    'embedding:computed', 'embedding:deleted',
  ];
  for (const eventType of allEventTypes) {
    eventBus.get(eventType as any).subscribe((event) => {
      eventCount++;
      process.stdout.write(JSON.stringify(event) + '\n');
    });
  }

  const label = isResourceScoped
    ? `Listening for events on resource ${rawResourceId}`
    : 'Listening for global events';

  if (!options.quiet) process.stderr.write(label + ' (Ctrl-C to stop)\n');

  const stream = isResourceScoped
    ? client.sse.resourceEvents(toResourceId(rawResourceId), { auth: token, eventBus })
    : client.sse.globalEvents({ auth: token, eventBus });

  // Wait for SIGINT/SIGTERM or stream close
  await new Promise<void>((resolve) => {
    const cleanup = () => {
      stream.close();
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
    results: [{ entity: rawResourceId ?? 'global', platform: 'posix', success: true, duration: Date.now() - startTime }],
  };
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const listenCmd = new CommandBuilder()
  .name('listen')
  .description(
    'Open a persistent SSE connection and stream domain events as NDJSON to stdout. ' +
    'Without a subcommand, streams global system events. ' +
    'With `resource <resourceId>`, streams events scoped to that resource. ' +
    'Runs until Ctrl-C or the server closes the connection.'
  )
  .requiresEnvironment(true)
  .requiresServices(true)
  .examples(
    'semiont listen',
    'semiont listen resource <resourceId>',
    'semiont listen resource <resourceId> | jq .type',
    'semiont listen | grep entitytype',
  )
  .args({
    ...withApiArgs({}, {}),
    restAs: 'args',
    aliases: {},
  })
  .schema(ListenOptionsSchema)
  .handler(runListen)
  .build();
