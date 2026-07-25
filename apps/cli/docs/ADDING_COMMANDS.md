# Adding New Commands to Semiont CLI

> **Scope.** This CLI covers **knowledge-base data** (`init`, `backup`, `restore`, `verify`,
> `export`, `import`) and **infrastructure** (`provision`, `start`, `stop`, `check`, `publish`,
> `update`, `watch`, `useradd`, `clean`, `local`/`serve`). Knowledge-work verbs (`browse`, `gather`,
> `mark`, `match`, `bind`, `listen`, `yield`, `beckon`, `login`) are **not** part of this package —
> they are verbs of the host-installed `semiont` launcher ([apps/launcher](../../launcher/README.md)),
> and the same capabilities are available programmatically through
> [`@semiont/sdk`](../../../packages/sdk/README.md). Do not add API-calling commands here.

The CLI has two families of commands with different patterns. Pick the right one before you start.

---

## Two Command Families

### 1. Infrastructure commands
Operate on services (`start`, `stop`, `check`, `provision`, …). They use the
`MultiServiceExecutor` / `CommandDescriptor` / `HandlerDescriptor` pattern — one handler per
`(platform, serviceType, command)` triple. See `src/core/commands/start.ts` as a reference, and
[ADDING_PLATFORMS.md](./ADDING_PLATFORMS.md) / [ADDING_SERVICES.md](./ADDING_SERVICES.md) for the
handler side. The rest of this guide does **not** cover this family.

### 2. Knowledge-base data commands
Operate directly on the KB's event log, content store, and graph via `@semiont/make-meaning`,
`@semiont/event-sourcing`, and `@semiont/content`. They use a simple `CommandBuilder` + handler
function pattern. This is what `backup`, `restore`, `verify`, `export`, and `import` all use.
**This guide covers this family.**

---

## Step-by-step: adding a knowledge-base data command

### 1. Create the command file

```
apps/cli/src/core/commands/my-command.ts
```

### 2. Define the schema

There are two schema tiers in `base-options-schema.ts`: `BaseOptionsSchema` (fields shared by every
command — `--verbose`, `--dry-run`, `--quiet`, `--output`, `--force-discovery`, `--preflight`) and
`OpsOptionsSchema` (adds `--environment`). Data commands use `OpsOptionsSchema`, since they need an
environment to locate the KB:

```typescript
import { z } from 'zod';
import { OpsOptionsSchema, withOpsArgs } from '../base-options-schema.js';

export const MyCommandOptionsSchema = OpsOptionsSchema.extend({
  // positional args collected here when using restAs
  args: z.array(z.string()).min(1, 'resourceId is required'),
  // command-specific flags
  force: z.boolean().default(false),
});

export type MyCommandOptions = z.output<typeof MyCommandOptionsSchema>;
```

`--environment` resolves from the flag, then `$SEMIONT_ENV`, then `defaults.environment` in
`~/.semiontconfig`.

### 3. Implement the handler

Resolve the project root and environment config, open the KB, do the work, and return
`CommandResults`:

```typescript
import { CommandResults } from '../command-types.js';
import { findProjectRoot, loadEnvironmentConfig } from '../config-loader.js';
import { printInfo, printSuccess } from '../io/cli-logger.js';

export async function runMyCommand(options: MyCommandOptions): Promise<CommandResults> {
  const startTime = Date.now();
  const projectRoot = findProjectRoot();
  const environment = options.environment!;
  const envConfig = loadEnvironmentConfig(projectRoot, environment);

  const [target] = options.args;

  // ... do the work (see backup.ts / export.ts for opening the event store,
  //     content store, and knowledge base)

  if (!options.quiet) printSuccess(`Done: ${target}`);

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
    results: [{ entity: target, platform: 'posix', success: true, duration: Date.now() - startTime }],
  };
}
```

Write machine-readable output to `stdout` and progress/labels to `stderr`, so `--output json` stays
pipeable.

### 4. Export the command definition

```typescript
import { CommandBuilder } from '../command-definition.js';

export const myCmd = new CommandBuilder()
  .name('my-command')
  .description('One-line description shown in semiont --help')
  .requiresEnvironment(true)
  .requiresServices(false)   // true only if the MultiServiceExecutor should resolve services
  .examples(
    'semiont my-command <resourceId>',
    'semiont my-command <resourceId> --force',
  )
  .args({
    ...withOpsArgs({
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

### Subcommands

Collect subcommands as positional args and validate the shape in the schema:

```typescript
export const MyOptionsSchema = OpsOptionsSchema.extend({
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
const [subcommand, target] = options.args;
if (subcommand === 'foo') { ... }
else { /* bar */ }
```

### Preflight checks

Commands can declare preflight checks that `--preflight` runs instead of the command body. See
`src/core/handlers/preflight-utils.ts` (`checkCommandAvailable`, `preflightFromChecks`) and
[ARCHITECTURE.md](./ARCHITECTURE.md#preflight-checks).

---

## Checklist

- [ ] Schema extends `OpsOptionsSchema` (or `BaseOptionsSchema` if no environment is needed)
- [ ] `.args()` uses `withOpsArgs`
- [ ] Machine-readable output on `stdout`; labels/progress on `stderr`
- [ ] Returns a valid `CommandResults` object
- [ ] Registered in `command-discovery.ts`
- [ ] `npx tsc --noEmit` passes clean
- [ ] Not an API-calling command (those belong to the launcher / `@semiont/sdk` — see Scope above)
