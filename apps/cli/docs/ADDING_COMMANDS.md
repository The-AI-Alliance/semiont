# Adding New Commands to Semiont CLI

The CLI has two families of commands with different patterns. Pick the right one before you start.

---

## Two Command Families

### 1. Infrastructure commands
Operate on services (start, stop, check, provision, …). They use the `MultiServiceExecutor` / `CommandDescriptor` / `HandlerDescriptor` pattern. See `src/core/commands/start.ts` as a reference. The rest of this guide does **not** cover this family.

### 2. Knowledge-base commands
Talk directly to the Semiont API. They use a simple `CommandBuilder` + handler function pattern. This is what `browse`, `gather`, `mark`, `yield`, `bind`, `match`, `listen`, and `mv` all use. **This guide covers this family.**

---

## Step-by-step: adding a knowledge-base command

### 1. Create the command file

```
apps/cli/src/core/commands/my-command.ts
```

### 2. Define the schema

Use `ApiOptionsSchema` (for commands that call the API) or `BaseOptionsSchema` (for commands that don't):

```typescript
import { z } from 'zod';
import { ApiOptionsSchema, withApiArgs } from '../base-options-schema.js';

export const MyCommandOptionsSchema = ApiOptionsSchema.extend({
  // positional args collected here when using restAs
  args: z.array(z.string()).min(1, 'resourceId is required'),
  // command-specific flags
  force: z.boolean().default(false),
});

export type MyCommandOptions = z.output<typeof MyCommandOptionsSchema>;
```

`ApiOptionsSchema` extends `BaseOptionsSchema` with `--bus`, `--user`, and `--password` connection overrides. Only use it when the command calls `createAuthenticatedClient`.

### 3. Implement the handler

```typescript
import { CommandResults } from '../command-types.js';
import { findProjectRoot } from '../config-loader.js';
import { createAuthenticatedClient } from '../api-client-factory.js';

export async function runMyCommand(options: MyCommandOptions): Promise<CommandResults> {
  const startTime = Date.now();
  const projectRoot = findProjectRoot();
  const environment = options.environment!;

  const { client, token } = await createAuthenticatedClient(
    projectRoot,
    environment,
    { bus: options.bus, user: options.user, password: options.password }
  );

  const [rawResourceId] = options.args;

  // Call the API
  const result = await client.someMethod(rawResourceId, { auth: token });

  // Write JSON to stdout; progress label to stderr
  if (!options.quiet) process.stderr.write(`Done: ${rawResourceId}\n`);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');

  return {
    command: 'my-command',
    environment,
    timestamp: new Date(),
    duration: Date.now() - startTime,
    summary: { succeeded: 1, failed: 0, total: 1, warnings: 0 },
    executionContext: {
      user: process.env.USER || 'unknown',
      workingDirectory: process.cwd(),
      dryRun: options.dryRun,
    },
    results: [{ entity: rawResourceId, platform: 'posix', success: true }],
  };
}
```

### 4. Export the command definition

```typescript
import { CommandBuilder } from '../command-definition.js';

export const myCmd = new CommandBuilder()
  .name('my-command')
  .description('One-line description shown in semiont --help')
  .requiresEnvironment(true)
  .requiresServices(true)
  .examples(
    'semiont my-command <resourceId>',
    'semiont my-command <resourceId> --force',
  )
  .args({
    ...withApiArgs({
      '--force': {
        type: 'boolean',
        description: 'Force the operation',
        default: false,
      },
    }, {}),
    restAs: 'args',   // positional args land in options.args
    aliases: {},
  })
  .schema(MyCommandOptionsSchema)
  .handler(runMyCommand)
  .build();
```

Use `withBaseArgs` instead of `withApiArgs` if the command does not call the API.

### 5. Register the command

Add the import and entry to `apps/cli/src/core/command-discovery.ts`:

```typescript
import { myCmd } from './commands/my-command.js';

const COMMANDS: Record<string, CommandDefinition<any>> = {
  // ... existing entries
  'my-command': myCmd,
};
```

This file is the single source of truth for all registered commands.

### 6. Type-check

```bash
npx tsc --noEmit -p apps/cli/tsconfig.json
```

---

## Common patterns

### Subcommands (browse-style)

Collect subcommands as positional args:

```typescript
export const MyOptionsSchema = ApiOptionsSchema.extend({
  args: z.array(z.string()).min(1, 'Subcommand required: foo | bar'),
}).superRefine((val, ctx) => {
  const sub = val.args[0];
  const valid = ['foo', 'bar'];
  if (!valid.includes(sub)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom,
      message: `Unknown subcommand '${sub}'. Valid: ${valid.join(', ')}` });
  }
  if (sub === 'foo' && val.args.length < 2) {
    ctx.addIssue({ code: z.ZodIssueCode.custom,
      message: 'Usage: semiont my-command foo <resourceId>' });
  }
});
```

Then dispatch in the handler:

```typescript
const [subcommand, rawResourceId] = options.args;
if (subcommand === 'foo') { ... }
else { /* bar */ }
```

### SSE long-lived streams (listen-style)

```typescript
import { EventBus, type ResourceEventType } from '@semiont/core';

const eventBus = new EventBus();

// Subscribe to specific typed channels
const eventTypes: ResourceEventType[] = ['mark:added', 'mark:removed', 'job:completed'];
for (const type of eventTypes) {
  eventBus.get(type as any).subscribe((event) => {
    process.stdout.write(JSON.stringify(event) + '\n');
  });
}

const stream = client.sse.resourceEvents(resourceId, { auth: token, eventBus });

await new Promise<void>((resolve) => {
  const cleanup = () => { stream.close(); resolve(); };
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
});
```

### SSE one-shot streams (gather/bind-style)

Subscribe to the completion event before starting the stream, then await:

```typescript
import { EventBus } from '@semiont/core';

const eventBus = new EventBus();

const donePromise = new Promise<SomeType>((resolve, reject) => {
  eventBus.get('gather:finished').subscribe((e) => resolve(e.context));
  eventBus.get('gather:failed').subscribe((e) => reject(e.error));  // 'gather:failed' is SSE infra
});

client.sse.gatherResource(resourceId, requestBody, { auth: token, eventBus });

const result = await donePromise;
```

---

## Checklist

- [ ] Schema extends `ApiOptionsSchema` (or `BaseOptionsSchema` if no API calls)
- [ ] `.args()` uses `withApiArgs` (or `withBaseArgs`)
- [ ] `createAuthenticatedClient` receives `{ bus, user, password }` from options
- [ ] JSON written to `stdout`; labels/progress written to `stderr`
- [ ] Returns a valid `CommandResults` object
- [ ] Registered in `command-discovery.ts`
- [ ] `npx tsc --noEmit` passes clean
