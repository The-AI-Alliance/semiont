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

There are three schema tiers in `base-options-schema.ts`: `BaseOptionsSchema` (fields shared by every command), `OpsOptionsSchema` (adds `--environment`, for platform/service commands), and `ApiOptionsSchema` (adds `--bus`, for commands that talk to the backend). Knowledge-base commands use `ApiOptionsSchema`:

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

`ApiOptionsSchema` extends `BaseOptionsSchema` with `--bus` (alias `-b`, fallback `$SEMIONT_BUS`). There are no `--user`/`--password` flags — authentication comes from the token cached by `semiont login`. Only use it when the command calls `loadCachedClient`.

### 3. Implement the handler

```typescript
import { CommandResults } from '../command-types.js';
import { loadCachedClient, resolveBusUrl } from '../client-factory.js';

export async function runMyCommand(options: MyCommandOptions): Promise<CommandResults> {
  const startTime = Date.now();
  const rawBusUrl = resolveBusUrl(options.bus);
  const { semiont } = loadCachedClient(rawBusUrl);

  const [rawResourceId] = options.args;

  // Call the API through the SDK client's namespaces
  const result = await semiont.myNamespace.someMethod(rawResourceId);

  // Write JSON to stdout; progress label to stderr
  if (!options.quiet) process.stderr.write(`Done: ${rawResourceId}\n`);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');

  return {
    command: 'my-command',
    environment: rawBusUrl,
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

`loadCachedClient(rawBusUrl)` returns `{ semiont, token }` — a `SemiontClient` from `@semiont/sdk` plus the cached `AccessToken` (useful for listen-style state units). It throws a user-facing "Not logged in" error if no valid token exists for that bus URL.

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

Use `withOpsArgs` instead of `withApiArgs` if the command operates on environments/services (adds `--environment`/`-e` instead of `--bus`/`-b`).

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

### Long-lived bus subscriptions (listen-style)

```typescript
import { createActorStateUnit } from '@semiont/http-transport';

const actor = createActorStateUnit({
  baseUrl: rawBusUrl,
  token,
  channels: ['mark:added', 'mark:removed', 'job:completed'],
});

// For resource-scoped channels, add with a scope:
// actor.addChannels(['mark:added', ...], resourceId);

for (const channel of ['mark:added', 'mark:removed', 'job:completed']) {
  actor.on$(channel).subscribe((event) => {
    process.stdout.write(JSON.stringify(event) + '\n');
  });
}

actor.start();

await new Promise<void>((resolve) => {
  const cleanup = () => { actor.dispose(); resolve(); };
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
});
```

See the `listen` command for a working example.

### One-shot bus request-response (gather/bind-style)

SDK namespace methods are called directly on the `semiont` client. Promise-returning methods are awaited as usual; observable-returning methods (long-running backend work that streams progress) are resolved with rxjs `lastValueFrom`:

```typescript
import { lastValueFrom } from 'rxjs';

// Promise-returning method
const context = await semiont.gather.resource(resourceId, { contextWindow: 1000 });

// Observable-returning method — completes when the backend finishes
const result = await lastValueFrom(
  semiont.gather.annotation(resourceId, annotationId, { contextWindow: 1000 }),
);
```

See `gather.ts` and `bind.ts` for working examples.

---

## Checklist

- [ ] Schema extends `ApiOptionsSchema` (or `OpsOptionsSchema`/`BaseOptionsSchema` if no API calls)
- [ ] `.args()` uses `withApiArgs` (or `withOpsArgs`)
- [ ] `loadCachedClient(resolveBusUrl(options.bus))` provides the authenticated `semiont` client
- [ ] JSON written to `stdout`; labels/progress written to `stderr`
- [ ] Returns a valid `CommandResults` object
- [ ] Registered in `command-discovery.ts`
- [ ] `npx tsc --noEmit` passes clean
