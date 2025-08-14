# CLI Command Registry Refactoring Plan

## Current State Analysis

### Problems
1. **Duplicated Command Definitions**: Commands are defined in TWO places:
   - `cli.ts` has a COMMANDS object with schemas and metadata
   - `lib/command-registry.ts` has a separate COMMANDS registry that's never used
   
2. **Inconsistent Argument Parsing**: 
   - `cli.ts` uses a massive imperative `parseArguments()` function with command-specific if/else blocks
   - Each command file defines its own Zod schema but they're not used for CLI parsing
   - The arg library parsing is completely separate from Zod validation

3. **Type Safety Issues**:
   - No compile-time guarantee that CLI args match command expectations
   - Manual mapping between arg names and command options
   - Duplicate validation (arg library + Zod)

## Proposed Architecture

### 1. Unified Command Registry
Merge both registries into a single source of truth with full metadata:

```typescript
// lib/command-registry.ts
export interface CommandDefinition<TOptions extends BaseCommandOptions> {
  name: string;
  description: string;
  schema: z.ZodType<TOptions>;  // Zod schema for validation
  argSpec: ArgSpec;              // Declarative arg specification
  requiresEnvironment: boolean;
  requiresServices: boolean;
  examples: string[];
  handler: CommandFunction<TOptions>;
}

// Declarative argument specification
export interface ArgSpec {
  args: Record<string, ArgDefinition>;
  aliases: Record<string, string>;
}

export interface ArgDefinition {
  type: 'string' | 'boolean' | 'number' | 'array';
  description: string;
  default?: any;
  choices?: string[];
}
```

### 2. Functional Argument Parser Generator
Replace the imperative parseArguments with a functional approach:

```typescript
// lib/arg-parser.ts
export function createArgParser<T extends BaseCommandOptions>(
  command: CommandDefinition<T>
): (argv: string[]) => T {
  const argSpec = buildArgSpec(command.argSpec);
  
  return (argv: string[]) => {
    const rawArgs = arg(argSpec, { argv });
    const validated = command.schema.parse(normalizeArgs(rawArgs));
    return validated;
  };
}

// Transform declarative spec to arg library format
function buildArgSpec(spec: ArgSpec): arg.Spec {
  return Object.entries(spec.args).reduce((acc, [key, def]) => {
    acc[key] = getArgType(def.type);
    return acc;
  }, spec.aliases);
}
```

### 3. Command Module Pattern
Each command exports its complete definition:

```typescript
// commands/backup.ts
import { defineCommand } from '../lib/command-registry.js';

export const BackupOptionsSchema = z.object({
  environment: z.string(),
  name: z.string().optional(),
  outputPath: z.string().default('./backups'),
  compress: z.boolean().default(true),
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  output: z.enum(['summary', 'table', 'json', 'yaml']).default('summary'),
});

export const backupCommand = defineCommand({
  name: 'backup',
  description: 'Create database backups',
  schema: BackupOptionsSchema,
  argSpec: {
    args: {
      '--name': { type: 'string', description: 'Backup name' },
      '--output-path': { type: 'string', description: 'Output directory', default: './backups' },
      '--no-compress': { type: 'boolean', description: 'Skip compression' },
      '--environment': { type: 'string', description: 'Target environment' },
      '--verbose': { type: 'boolean', description: 'Verbose output' },
      '--dry-run': { type: 'boolean', description: 'Preview without executing' },
      '--output': { 
        type: 'string', 
        description: 'Output format',
        choices: ['summary', 'table', 'json', 'yaml'],
        default: 'summary'
      },
    },
    aliases: {
      '-n': '--name',
      '-e': '--environment',
      '-v': '--verbose',
      '-o': '--output',
    }
  },
  requiresEnvironment: true,
  requiresServices: true,
  examples: [
    'semiont backup -e production',
    'semiont backup -e staging --name "pre-upgrade"',
  ],
  handler: backup, // The actual command function
});
```

### 4. Dynamic Command Loader
Replace the massive switch statement in cli.ts:

```typescript
// lib/command-loader.ts
export async function loadCommand(name: string): Promise<CommandDefinition<any>> {
  const module = await import(`../commands/${name}.js`);
  const command = module[`${name}Command`];
  
  if (!command) {
    throw new Error(`Command ${name} not properly exported`);
  }
  
  return command;
}

// cli.ts - simplified execution
async function executeCommand(
  commandName: string,
  argv: string[]
): Promise<void> {
  const command = await loadCommand(commandName);
  const parser = createArgParser(command);
  const options = parser(argv);
  
  // Validate environment if required
  if (command.requiresEnvironment) {
    validateEnvironment(options.environment);
  }
  
  // Resolve services if required
  let services: ServiceDeploymentInfo[] = [];
  if (command.requiresServices) {
    services = await resolveServices(options);
  }
  
  // Execute command
  const results = await command.handler(services, options);
  
  // Format output
  const formatted = formatResults(results, options.output);
  console.log(formatted);
}
```

### 5. Type-Safe Command Builder
Helper functions for maximum type safety:

```typescript
// lib/command-builder.ts
export class CommandBuilder<T extends BaseCommandOptions> {
  private definition: Partial<CommandDefinition<T>> = {};
  
  name(name: string): this {
    this.definition.name = name;
    return this;
  }
  
  schema<S extends z.ZodType<T>>(schema: S): this {
    this.definition.schema = schema;
    return this;
  }
  
  args(args: ArgSpec): this {
    this.definition.argSpec = args;
    return this;
  }
  
  handler(fn: CommandFunction<T>): this {
    this.definition.handler = fn;
    return this;
  }
  
  build(): CommandDefinition<T> {
    // Validate completeness at runtime
    if (!this.definition.name || !this.definition.schema || !this.definition.handler) {
      throw new Error('Incomplete command definition');
    }
    return this.definition as CommandDefinition<T>;
  }
}

// Usage
export const backupCommand = new CommandBuilder<BackupOptions>()
  .name('backup')
  .schema(BackupOptionsSchema)
  .args({...})
  .handler(backup)
  .build();
```

## Migration Strategy

### Phase 1: Infrastructure (No Breaking Changes)
1. Create new unified command registry structure
2. Implement functional arg parser generator
3. Add command builder utilities
4. Create tests for new infrastructure

### Phase 2: Command Migration (One at a Time)
1. Start with simple commands (init, configure)
2. Migrate each command to export its definition
3. Keep backward compatibility by having cli.ts check both old and new patterns
4. Add tests for each migrated command

### Phase 3: CLI Integration
1. Replace parseArguments with new parser
2. Replace executeCommand switch with dynamic loader
3. Remove old COMMANDS object from cli.ts
4. Update help generation to use new registry

### Phase 4: Cleanup
1. Remove duplicate code
2. Remove unused command-registry.ts functions
3. Consolidate all command metadata in one place
4. Add comprehensive type tests

## Benefits

1. **Single Source of Truth**: One command definition instead of scattered pieces
2. **Type Safety**: Compile-time guarantees that args match command expectations
3. **Declarative**: Functional, declarative style instead of imperative parsing
4. **Testable**: Each piece is a pure function that's easy to test
5. **Maintainable**: Adding a new command just means creating one export
6. **Consistent**: All commands follow exactly the same pattern
7. **Self-Documenting**: Args, types, and descriptions all in one place

## Next Steps

1. Review and approve this plan
2. Create feature branch for refactoring
3. Implement Phase 1 infrastructure
4. Migrate one command as proof of concept
5. Continue migration based on results