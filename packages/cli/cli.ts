/**
 * Semiont CLI - TypeScript replacement for bash wrapper
 * 
 * This provides a unified entry point with:
 * - Common arguments (--environment, --verbose, etc.) available to all commands
 * - Type-safe argument parsing with Zod
 * - Consistent error handling and help generation
 */

import arg from 'arg';
import { z } from 'zod';
import { spawn } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
// Service enums are now validated at runtime for flexibility

// Get directory paths (ES modules compatible)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPTS_DIR = __dirname; // We're already in packages/scripts/dist

// Get version from package.json
const packageJsonPath = path.join(__dirname, '..', 'package.json');
let VERSION = 'unknown';
try {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  VERSION = packageJson.version || 'unknown';
} catch (error) {
  // Fallback if package.json can't be read
  VERSION = '1.0.0';
}

import { colors } from './lib/cli-colors.js';

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

// Common arguments available to ALL commands
const CommonArgsSchema = z.object({
  '--environment': z.enum(['local', 'development', 'staging', 'production']).optional(),
  '--verbose': z.boolean().optional(),
  '--dry-run': z.boolean().optional(),
  '--help': z.boolean().optional(),
  
  // Aliases
  '-e': z.literal('--environment').optional(),
  '-v': z.literal('--verbose').optional(),
  '-h': z.literal('--help').optional(),
});

// Command-specific schemas
const StartArgsSchema = CommonArgsSchema.extend({
  '--service': z.string().optional(), // Will be validated at runtime against available services
  '-s': z.literal('--service').optional(),
});

const TestArgsSchema = CommonArgsSchema.extend({
  '--suite': z.enum(['all', 'integration', 'e2e', 'health', 'security']).optional(),
  '--service': z.string().optional(), // Will be validated at runtime against testable services
  '--coverage': z.boolean().optional(),
  '--parallel': z.boolean().optional(),
  '-s': z.literal('--suite').optional(),
  '-p': z.literal('--parallel').optional(),
});

const UpdateArgsSchema = CommonArgsSchema.extend({
  '--skip-tests': z.boolean().optional(),
  '--skip-build': z.boolean().optional(),
  '--force': z.boolean().optional(),
  '-f': z.literal('--force').optional(),
});

const WatchArgsSchema = CommonArgsSchema.extend({
  '--target': z.enum(['all', 'logs', 'metrics', 'services']).optional(),
  '--service': z.string().optional(), // Will be validated at runtime against watchable services
  '--no-follow': z.boolean().optional(),
  '--interval': z.number().int().positive().optional(),
  '-t': z.literal('--target').optional(),
  '-s': z.literal('--service').optional(),
  '-i': z.literal('--interval').optional(),
});

const ExecArgsSchema = CommonArgsSchema.extend({
  '--service': z.string().optional(), // Will be validated at runtime against executable services
  '--command': z.string().optional(),
  '-s': z.literal('--service').optional(),
  '-c': z.literal('--command').optional(),
});

const ConfigureArgsSchema = CommonArgsSchema.extend({
  '--secret-path': z.string().optional(),
  '--value': z.string().optional(),
  '-s': z.literal('--secret-path').optional(),
});

const BackupArgsSchema = CommonArgsSchema.extend({
  '--name': z.string().optional(),
  '-n': z.literal('--name').optional(),
});

const CheckArgsSchema = CommonArgsSchema.extend({
  '--section': z.enum(['all', 'services', 'health', 'logs']).optional(),
  '-s': z.literal('--section').optional(),
});

const PublishArgsSchema = CommonArgsSchema.extend({
  '--service': z.string().optional(), // Will be validated at runtime against publishable services
  '--tag': z.string().optional(),
  '--skip-build': z.boolean().optional(),
  '-s': z.literal('--service').optional(),
  '-t': z.literal('--tag').optional(),
});

// Command registry with metadata
interface CommandDefinition {
  description: string;
  schema: z.ZodType<any>;
  handler: string;
  examples?: string[];
  requiresEnvironment?: boolean;
}

const COMMANDS: Record<string, CommandDefinition> = {
  provision: {
    description: 'Provision infrastructure (containers or cloud)',
    schema: CommonArgsSchema.extend({
      '--stack': z.enum(['infra', 'app', 'all']).optional(),
      '--force': z.boolean().optional(),
      '--destroy': z.boolean().optional(),
      '--no-approval': z.boolean().optional(),
      '--reset': z.boolean().optional(),
      '--seed': z.boolean().optional(),
      '-f': z.literal('--force').optional(),
    }),
    handler: 'commands/provision.mjs',
    requiresEnvironment: true,
    examples: [
      'semiont provision -e local --seed',
      'semiont provision -e production --stack infra',
      'semiont provision -e staging --dry-run',
      'semiont provision -e development --destroy',
    ],
  },
  configure: {
    description: 'Manage configuration and secrets',
    schema: ConfigureArgsSchema,
    handler: 'commands/configure.mjs',
    requiresEnvironment: true,
    examples: [
      'semiont configure -e local show',
      'semiont configure -e production list',
      'semiont configure -e staging validate',
      'semiont configure -e production get oauth/google',
      'semiont configure -e staging set jwt-secret',
    ],
  },
  publish: {
    description: 'Build and push container images (for containerized services)',
    schema: PublishArgsSchema,
    handler: 'commands/publish.mjs',
    requiresEnvironment: true,
    examples: [
      'semiont publish -e staging --service frontend',
      'semiont publish -e production --service all',
      'semiont publish -e staging --skip-build --tag v1.2.3',
      'semiont publish -e production --dry-run',
    ],
  },
  start: {
    description: 'Start services in any environment',
    schema: StartArgsSchema,
    handler: 'commands/start.mjs',
    requiresEnvironment: true,
    examples: [
      'semiont start --environment local',
      'semiont start -e staging --service backend',
      'semiont start -e local --service frontend',
    ],
  },
  check: {
    description: 'Check system health and status',
    schema: CheckArgsSchema,
    handler: 'commands/check.mjs',
    requiresEnvironment: true,
    examples: [
      'semiont check -e local',
      'semiont check -e staging --section services',
      'semiont check -e production --section health',
    ],
  },
  watch: {
    description: 'Monitor logs and system metrics',
    schema: WatchArgsSchema,
    handler: 'commands/watch.mjs',
    requiresEnvironment: true,
    examples: [
      'semiont watch -e local',
      'semiont watch -e staging --target logs',
      'semiont watch -e production --service backend --interval 10',
    ],
  },
  test: {
    description: 'Run tests against environments',
    schema: TestArgsSchema.extend({
      '--timeout': z.number().int().positive().optional(),
    }),
    handler: 'commands/test.mjs',
    requiresEnvironment: true,
    examples: [
      'semiont test -e local --suite integration',
      'semiont test -e staging --suite e2e',
      'semiont test -e production --suite health',
    ],
  },
  update: {
    description: 'Update running services with pre-built images',
    schema: UpdateArgsSchema,
    handler: 'commands/update.mjs',
    requiresEnvironment: true, // This command REQUIRES --environment
    examples: [
      'semiont update -e staging',
      'semiont update -e production --dry-run',
      'semiont update -e staging --skip-tests',
    ],
  },
  restart: {
    description: 'Restart services in any environment',
    schema: CommonArgsSchema.extend({
      '--service': z.string().optional(), // Will be validated at runtime against restartable services
      '--force': z.boolean().optional(),
      '--grace-period': z.number().int().positive().optional(),
      '-s': z.literal('--service').optional(),
      '-f': z.literal('--force').optional(),
    }),
    handler: 'commands/restart.mjs',
    requiresEnvironment: true,
    examples: [
      'semiont restart --environment local',
      'semiont restart -e staging --service backend',
      'semiont restart -e local --grace-period 5 --service all',
    ],
  },
  stop: {
    description: 'Stop services in any environment',
    schema: CommonArgsSchema.extend({
      '--service': z.string().optional(), // Will be validated at runtime against stoppable services
      '--force': z.boolean().optional(),
      '-s': z.literal('--service').optional(),
      '-f': z.literal('--force').optional(),
    }),
    handler: 'commands/stop.mjs',
    requiresEnvironment: true,
    examples: [
      'semiont stop --environment local',
      'semiont stop -e staging --service backend',
      'semiont stop -e local --force --service all',
    ],
  },
  exec: {
    description: 'Execute commands in cloud containers',
    schema: ExecArgsSchema,
    handler: 'commands/exec.mjs',
    requiresEnvironment: true,
    examples: [
      'semiont exec -e production',
      'semiont exec -e staging --service frontend',
      'semiont exec -e production --service backend --command "ls -la"',
    ],
  },
  backup: {
    description: 'Create database backups',
    schema: BackupArgsSchema,
    handler: 'commands/backup.mjs',
    requiresEnvironment: true,
    examples: [
      'semiont backup -e production',
      'semiont backup -e staging --name "pre-upgrade"',
      'semiont backup -e production --name "before-migration" --verbose',
      'semiont backup -e staging --dry-run',
    ],
  },
};

type CommandName = keyof typeof COMMANDS;

// =====================================================================
// HELPER FUNCTIONS
// =====================================================================

function printError(message: string): void {
  console.error(`${colors.red}❌ ${message}${colors.reset}`);
}


function printHelp(command?: CommandName): void {
  if (command && COMMANDS[command]) {
    const cmd = COMMANDS[command];
    console.log(`\n${colors.bright}${command}${colors.reset} - ${cmd.description}\n`);
    
    // Show command-specific options (skip for now due to Zod typing complexity)
    console.log(`${colors.bright}Options:${colors.reset}`);
    console.log(`  See common options above`);
    console.log(`  Run 'semiont ${command} --help' for command-specific options`);
    
    if (cmd.examples) {
      console.log(`\n${colors.bright}Examples:${colors.reset}`);
      for (const example of cmd.examples) {
        console.log(`  $ ${example}`);
      }
    }
  } else {
    // Print general help
    console.log(`
${colors.bright}🚀 Semiont Management Tool${colors.reset} (v${VERSION})

${colors.bright}Usage:${colors.reset}
  semiont <command> [options]

${colors.bright}Common Options:${colors.reset}
  -e, --environment <env>  Environment (local, development, staging, production)
  -v, --verbose           Verbose output
  --dry-run              Preview changes without applying
  -h, --help             Show help
  --version              Show version

${colors.bright}Environment Management Commands:${colors.reset}`);

    for (const [name, cmd] of Object.entries(COMMANDS)) {
      const required = cmd.requiresEnvironment ? ' (requires -e)' : '';
      console.log(`  ${colors.cyan}${name.padEnd(12)}${colors.reset} ${cmd.description}${required}`);
    }

    console.log(`
${colors.bright}Examples:${colors.reset}
  # Local Environment
  semiont start -e local                    # Start all local services
  semiont check -e local --section health  # Check local health
  semiont watch -e local --target logs     # Monitor local logs

  # Cloud Environments  
  semiont provision -e production           # Create infrastructure
  semiont publish -e staging                # Build and push images
  semiont update -e staging                 # Update running services
  semiont test -e production --suite health # Test production health

${colors.bright}For command-specific help:${colors.reset}
  semiont <command> --help

${colors.bright}For development (building/testing code):${colors.reset}
  cd packages/scripts && npm run build     # Build CLI
  npm test                                  # Run unit tests
`);
  }
}

async function parseArguments(
  command: CommandName,
  argv: string[]
): Promise<Record<string, any>> {
  const commandDef = COMMANDS[command];
  if (!commandDef) {
    throw new Error(`Command not found: ${command}`);
  }
  
  try {
    // Parse raw arguments
    const rawArgs = arg(
      {
        // Common arguments
        '--environment': String,
        '--verbose': Boolean,
        '--dry-run': Boolean,
        '--help': Boolean,
        '-e': '--environment',
        '-v': '--verbose',
        '-h': '--help',
        
        // Command-specific arguments
        ...(command === 'start' || command === 'stop' || command === 'restart' ? {
          '--service': String,
          '-s': '--service',
        } : {}),
        
        
        ...(command === 'stop' || command === 'restart' ? {
          '--force': Boolean,
          '-f': '--force',
        } : {}),
        
        ...(command === 'restart' ? {
          '--grace-period': Number,
        } : {}),
        
        ...(command === 'test' ? {
          '--suite': String,
          '--service': String,
          '--coverage': Boolean,
          '--parallel': Boolean,
          '--timeout': Number,
          '-s': '--suite',
          '-p': '--parallel',
        } : {}),
        
        ...(command === 'check' ? {
          '--section': String,
          '-s': '--section',
        } : {}),
        
        ...(command === 'update' ? {
          '--skip-tests': Boolean,
          '--skip-build': Boolean,
          '--force': Boolean,
          '-f': '--force',
        } : {}),
        
        ...(command === 'provision' ? {
          '--stack': String,
          '--force': Boolean,
          '--destroy': Boolean,
          '--no-approval': Boolean,
          '--reset': Boolean,
          '--seed': Boolean,
          '-f': '--force',
        } : {}),
        
        ...(command === 'watch' ? {
          '--target': String,
          '--service': String,
          '--no-follow': Boolean,
          '--interval': Number,
          '-t': '--target',
          '-s': '--service',
          '-i': '--interval',
        } : {}),
        
        ...(command === 'exec' ? {
          '--service': String,
          '--command': String,
          '-s': '--service',
          '-c': '--command',
        } : {}),
        
        ...(command === 'configure' ? {
          '--secret-path': String,
          '--value': String,
          '-s': '--secret-path',
        } : {}),
        
        ...(command === 'backup' ? {
          '--name': String,
          '-n': '--name',
        } : {}),
        
        ...(command === 'publish' ? {
          '--service': String,
          '--tag': String,
          '--skip-build': Boolean,
          '-s': '--service',
          '-t': '--tag',
        } : {}),
      },
      { argv }
    );
    
    // Show help if requested
    if (rawArgs['--help']) {
      printHelp(command);
      process.exit(0);
    }
    
    // Validate with Zod schema
    const validated = commandDef.schema.parse(rawArgs);
    
    // Check required environment
    if (commandDef.requiresEnvironment && !validated['--environment']) {
      throw new Error(`--environment is required for '${command}' command`);
    }
    
    return validated;
  } catch (error) {
    if (error instanceof z.ZodError) {
      printError('Invalid arguments:');
      for (const issue of error.issues) {
        console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
      }
    } else if (error instanceof Error) {
      printError(error.message);
    }
    console.log(`\nRun 'semiont ${command} --help' for usage information`);
    process.exit(1);
  }
}

async function ensureBuilt(): Promise<void> {
  // The CLI itself is built, so assume other scripts are too
  // If individual commands fail, they'll show their own errors
  return;
}

async function executeCommand(
  command: CommandName,
  args: Record<string, any>
): Promise<void> {
  const commandDef = COMMANDS[command];
  if (!commandDef) {
    throw new Error(`Command not found: ${command}`);
  }
  const handlerPath = path.join(SCRIPTS_DIR, commandDef.handler);
  
  // Convert arguments to command line format
  const cliArgs: string[] = [];
  
  // Environment is often positional for legacy scripts
  if (args['--environment']) {
    cliArgs.push(args['--environment']);
  }
  
  // Add other arguments
  for (const [key, value] of Object.entries(args)) {
    if (key.startsWith('--') && key !== '--environment' && value !== undefined) {
      if (typeof value === 'boolean') {
        if (value) cliArgs.push(key);
      } else {
        cliArgs.push(key, String(value));
      }
    }
  }
  
  // Execute the command
  const proc = spawn('node', [handlerPath, ...cliArgs], {
    stdio: 'inherit',
    env: {
      ...process.env,
      SEMIONT_ENV: args['--environment'] || process.env.SEMIONT_ENV || 'local',
      SEMIONT_VERBOSE: args['--verbose'] ? '1' : '0',
      SEMIONT_DRY_RUN: args['--dry-run'] ? '1' : '0',
    },
  });
  
  proc.on('exit', (code) => {
    process.exit(code || 0);
  });
}

// =====================================================================
// MAIN ENTRY POINT
// =====================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  // Handle --version flag (not -v since that's verbose)
  if (args.includes('--version')) {
    console.log(`semiont version ${VERSION}`);
    process.exit(0);
  }
  
  // Handle no arguments or help
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    process.exit(0);
  }
  
  // Extract command
  const command = args[0] as CommandName;
  
  if (!COMMANDS[command]) {
    printError(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }
  
  // Parse command arguments
  const commandArgs = await parseArguments(command, args.slice(1));
  
  // Ensure scripts are built
  await ensureBuilt();
  
  // Execute the command
  await executeCommand(command, commandArgs);
}

// Run the CLI
main().catch((error) => {
  printError(`Unexpected error: ${error.message}`);
  process.exit(1);
});