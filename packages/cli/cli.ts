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
import { readFileSync } from 'fs';
import { getAvailableEnvironments, isValidEnvironment } from './lib/deployment-resolver.js';
import { CommandResults } from './lib/command-results.js';
// Service enums are now validated at runtime for flexibility

// Get version from package.json
import * as path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
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
  '--environment': z.string().optional(),
  '--config-file': z.string().optional(),  // Path to semiont.json
  '--output': z.enum(['summary', 'table', 'json', 'yaml']).optional(),
  '--quiet': z.boolean().optional(),
  '--verbose': z.boolean().optional(),
  '--dry-run': z.boolean().optional(),
  '--help': z.boolean().optional(),
  
  // Aliases
  '-e': z.literal('--environment').optional(),
  '-f': z.literal('--config-file').optional(),
  '-o': z.literal('--output').optional(),
  '-q': z.literal('--quiet').optional(),
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

const InitArgsSchema = z.object({
  '--name': z.string().optional(),
  '--directory': z.string().optional(),
  '--force': z.boolean().optional(),
  '--environments': z.string().optional(), // Comma-separated list
  '--output': z.enum(['summary', 'json', 'yaml']).optional(),
  '--quiet': z.boolean().optional(),
  '--verbose': z.boolean().optional(),
  '-n': z.literal('--name').optional(),
  '-d': z.literal('--directory').optional(),
  '-f': z.literal('--force').optional(),
});

const BackupArgsSchema = CommonArgsSchema.extend({
  '--name': z.string().optional(),
  '-n': z.literal('--name').optional(),
});

const CheckArgsSchema = CommonArgsSchema.extend({
  '--service': z.string().optional(),
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
  examples?: string[];
  requiresEnvironment?: boolean;
}

const COMMANDS: Record<string, CommandDefinition> = {
  init: {
    description: 'Initialize a new Semiont project',
    schema: InitArgsSchema,
    requiresEnvironment: false,
    examples: [
      'semiont init',
      'semiont init --name my-project',
      'semiont init --environments local,staging,production',
      'semiont init --directory ./my-app',
    ],
  },
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

// Get environment with fallback: --environment > SEMIONT_ENV > 'local'
function getEnvironmentWithFallback(args: Record<string, any>): string {
  return args['--environment'] || process.env.SEMIONT_ENV || 'local';
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
  -e, --environment <env>  Environment (${getAvailableEnvironments().join(', ') || 'none found'}) [default: $SEMIONT_ENV or 'local']
  -o, --output <format>   Output format (summary, table, json, yaml) [default: summary]
  -q, --quiet            Suppress output except errors
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

${colors.bright}Environment Selection:${colors.reset}
  Set SEMIONT_ENV environment variable to avoid typing -e every time:
    export SEMIONT_ENV=staging
    semiont start                          # Uses staging environment
    semiont start -e production             # Override with -e flag

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
        '--output': String,
        '--quiet': Boolean,
        '--verbose': Boolean,
        '--dry-run': Boolean,
        '--help': Boolean,
        '-e': '--environment',
        '-o': '--output',
        '-q': '--quiet',
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
          '--service': String,
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

        ...(command === 'init' ? {
          '--name': String,
          '--directory': String,
          '--force': Boolean,
          '--environments': String,
          '-n': '--name',
          '-d': '--directory',
          '-f': '--force',
        } : {}),
        
        ...(command === 'backup' ? {
          '--name': String,
          '--output-path': String,
          '--no-compress': Boolean,
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
    
    // Handle environment: --environment overrides SEMIONT_ENV
    if (!validated['--environment'] && process.env.SEMIONT_ENV) {
      validated['--environment'] = process.env.SEMIONT_ENV;
    }
    
    // Validate environment dynamically against filesystem
    if (validated['--environment']) {
      const availableEnvironments = getAvailableEnvironments();
      if (!isValidEnvironment(validated['--environment'])) {
        if (availableEnvironments.length === 0) {
          throw new Error(`No environment configurations found. Create files in config/environments/`);
        } else {
          throw new Error(`Unknown environment '${validated['--environment']}'. Available: ${availableEnvironments.join(', ')}`);
        }
      }
    }
    
    // Check required environment
    if (commandDef.requiresEnvironment && !validated['--environment']) {
      const availableEnvironments = getAvailableEnvironments();
      const envList = availableEnvironments.length > 0 ? availableEnvironments.join(', ') : 'none found';
      throw new Error(`--environment is required for '${command}' command. Available: ${envList}\nYou can also set the SEMIONT_ENV environment variable.`);
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

// Unified command dispatcher - handles all commands with single execution path
async function executeCommand(
  command: CommandName,
  args: Record<string, any>
): Promise<CommandResults> {
  const commandDef = COMMANDS[command];
  if (!commandDef) {
    throw new Error(`Command not found: ${command}`);
  }
  
  // Single unified execution path - all commands return CommandResults
  const outputFormat = args['--output'] || 'summary';
  let results: CommandResults;
  
  switch (command) {
      case 'check': {
        const { check } = await import('./commands/check.js');
        const { validateServiceSelector, resolveServiceSelector } = await import('./lib/services.js');
        const { resolveServiceDeployments } = await import('./lib/deployment-resolver.js');
        
        const environment = getEnvironmentWithFallback(args);
        const service = args['--service'] || 'all';
        
        // Resolve services first
        await validateServiceSelector(service, 'check', environment);
        const resolvedServices = await resolveServiceSelector(service, 'check', environment);
        const serviceDeployments = resolveServiceDeployments(resolvedServices, environment);
        
        const checkOptions = {
          environment,
          section: args['--section'] || 'all',
          verbose: args['--verbose'] || false,
          dryRun: args['--dry-run'] || false,
          output: outputFormat
        };
        results = await check(serviceDeployments, checkOptions);
        break;
      }
      
      case 'start': {
        const { start } = await import('./commands/start.js');
        const { validateServiceSelector, resolveServiceSelector } = await import('./lib/services.js');
        const { resolveServiceDeployments } = await import('./lib/deployment-resolver.js');
        
        const environment = getEnvironmentWithFallback(args);
        const service = args['--service'] || 'all';
        
        // Resolve services first
        await validateServiceSelector(service, 'start', environment);
        const resolvedServices = await resolveServiceSelector(service, 'start', environment);
        const serviceDeployments = resolveServiceDeployments(resolvedServices, environment);
        
        const startOptions = {
          environment,
          output: outputFormat,
          quiet: args['--quiet'] || false,
          verbose: args['--verbose'] || false,
          dryRun: args['--dry-run'] || false
        };
        results = await start(serviceDeployments, startOptions);
        break;
      }
      
      case 'stop': {
        const { stop } = await import('./commands/stop.js');
        const { validateServiceSelector, resolveServiceSelector } = await import('./lib/services.js');
        const { resolveServiceDeployments } = await import('./lib/deployment-resolver.js');
        
        const environment = getEnvironmentWithFallback(args);
        const service = args['--service'] || 'all';
        
        // Resolve services first
        await validateServiceSelector(service, 'stop', environment);
        const resolvedServices = await resolveServiceSelector(service, 'stop', environment);
        const serviceDeployments = resolveServiceDeployments(resolvedServices, environment);
        
        const stopOptions = {
          environment,
          output: outputFormat,
          force: args['--force'] || false,
          verbose: args['--verbose'] || false,
          dryRun: args['--dry-run'] || false
        };
        results = await stop(serviceDeployments, stopOptions);
        break;
      }
      
      case 'restart': {
        const { restart } = await import('./commands/restart.js');
        const { validateServiceSelector, resolveServiceSelector } = await import('./lib/services.js');
        const { resolveServiceDeployments } = await import('./lib/deployment-resolver.js');
        
        const environment = getEnvironmentWithFallback(args);
        const service = args['--service'] || 'all';
        
        // Resolve services first
        await validateServiceSelector(service, 'restart', environment);
        const resolvedServices = await resolveServiceSelector(service, 'restart', environment);
        const serviceDeployments = resolveServiceDeployments(resolvedServices, environment);
        
        const restartOptions = {
          environment,
          output: outputFormat,
          force: args['--force'] || false,
          verbose: args['--verbose'] || false,
          dryRun: args['--dry-run'] || false,
          gracePeriod: args['--grace-period'] || 3
        };
        results = await restart(serviceDeployments, restartOptions);
        break;
      }
      
      case 'provision': {
        const { provision } = await import('./commands/provision.js');
        const { validateServiceSelector, resolveServiceSelector } = await import('./lib/services.js');
        const { resolveServiceDeployments } = await import('./lib/deployment-resolver.js');
        
        const environment = getEnvironmentWithFallback(args);
        const service = args['--service'] || 'all';
        
        // Resolve services first (using 'start' as the command type for provisioning)
        await validateServiceSelector(service, 'start', environment);
        const resolvedServices = await resolveServiceSelector(service, 'start', environment);
        const serviceDeployments = resolveServiceDeployments(resolvedServices, environment);
        
        const provisionOptions = {
          environment,
          stack: args['--stack'] || 'all',
          destroy: args['--destroy'] || false,
          force: args['--force'] || false,
          requireApproval: args['--no-approval'] ? false : undefined,
          reset: args['--reset'] || false,
          seed: args['--seed'] || false,
          verbose: args['--verbose'] || false,
          dryRun: args['--dry-run'] || false,
          output: outputFormat
        };
        results = await provision(serviceDeployments, provisionOptions);
        break;
      }
      
      case 'publish': {
        const { publish } = await import('./commands/publish.js');
        const publishOptions = {
          environment: getEnvironmentWithFallback(args),
          service: args['--service'] || 'all',
          output: outputFormat,
          tag: args['--tag'] || 'latest',
          skipBuild: args['--skip-build'] || false,
          verbose: args['--verbose'] || false,
          dryRun: args['--dry-run'] || false
        };
        results = await publish(publishOptions);
        break;
      }
      
      case 'update': {
        const { update } = await import('./commands/update.js');
        const updateOptions = {
          environment: getEnvironmentWithFallback(args),
          service: args['--service'] || 'all',
          skipTests: args['--skip-tests'] || false,
          skipBuild: args['--skip-build'] || false,
          force: args['--force'] || false,
          gracePeriod: args['--grace-period'] || 3,
          verbose: args['--verbose'] || false,
          dryRun: args['--dry-run'] || false,
          output: outputFormat
        };
        results = await update(updateOptions);
        break;
      }
      
      case 'test': {
        const { test } = await import('./commands/test.js');
        const { validateServiceSelector, resolveServiceSelector } = await import('./lib/services.js');
        const { resolveServiceDeployments } = await import('./lib/deployment-resolver.js');
        
        const environment = getEnvironmentWithFallback(args);
        const service = args['--service'] || 'all';
        
        // Resolve services first
        await validateServiceSelector(service, 'test', environment);
        const resolvedServices = await resolveServiceSelector(service, 'test', environment);
        const serviceDeployments = resolveServiceDeployments(resolvedServices, environment);
        
        const testOptions = {
          environment,
          suite: args['--suite'] || 'all',
          coverage: args['--coverage'] || false,
          parallel: args['--parallel'] || false,
          timeout: args['--timeout'] || 300,
          verbose: args['--verbose'] || false,
          dryRun: args['--dry-run'] || false,
          output: outputFormat
        };
        results = await test(serviceDeployments, testOptions);
        break;
      }
      
      case 'backup': {
        const { backup } = await import('./commands/backup.js');
        const { validateServiceSelector, resolveServiceSelector } = await import('./lib/services.js');
        const { resolveServiceDeployments } = await import('./lib/deployment-resolver.js');
        
        const environment = getEnvironmentWithFallback(args);
        const service = args['--service'] || 'all';
        
        // Resolve services first
        await validateServiceSelector(service, 'backup', environment);
        const resolvedServices = await resolveServiceSelector(service, 'backup', environment);
        const serviceDeployments = resolveServiceDeployments(resolvedServices, environment);
        
        const backupOptions = {
          environment,
          name: args['--name'],
          outputPath: args['--output-path'] || './backups',
          compress: !args['--no-compress'],
          verbose: args['--verbose'] || false,
          dryRun: args['--dry-run'] || false,
          output: outputFormat
        };
        results = await backup(serviceDeployments, backupOptions);
        break;
      }
      
      case 'exec': {
        const { exec } = await import('./commands/exec.js');
        const { validateServiceSelector, resolveServiceSelector } = await import('./lib/services.js');
        const { resolveServiceDeployments } = await import('./lib/deployment-resolver.js');
        
        const environment = getEnvironmentWithFallback(args);
        const service = args['--service'] || 'backend';
        
        // Validate and resolve service for exec (single service only)
        await validateServiceSelector(service, 'exec', environment);
        const resolvedServices = await resolveServiceSelector(service, 'exec', environment);
        
        if (resolvedServices.length > 1) {
          throw new Error(`Can only execute commands in one service at a time. Resolved to: ${resolvedServices.join(', ')}`);
        }
        
        const serviceDeployments = resolveServiceDeployments(resolvedServices, environment);
        const serviceDeployment = serviceDeployments[0];
        
        if (!serviceDeployment) {
          throw new Error('No service found');
        }
        
        const execOptions = {
          environment,
          command: args['--command'] || '/bin/sh',
          interactive: true,
          verbose: args['--verbose'] || false,
          dryRun: args['--dry-run'] || false,
          output: outputFormat
        };
        
        results = await exec(serviceDeployment, execOptions);
        break;
      }
      
      case 'watch': {
        const { watch } = await import('./commands/watch.js');
        const { validateServiceSelector, resolveServiceSelector } = await import('./lib/services.js');
        const { resolveServiceDeployments } = await import('./lib/deployment-resolver.js');
        
        const environment = getEnvironmentWithFallback(args);
        const service = args['--service'] || 'all';
        
        // Resolve services first
        await validateServiceSelector(service, 'watch', environment);
        const resolvedServices = await resolveServiceSelector(service, 'watch', environment);
        const serviceDeployments = resolveServiceDeployments(resolvedServices, environment);
        
        const watchOptions = {
          environment,
          target: args['--target'] || 'all',
          noFollow: args['--no-follow'] || false,
          interval: args['--interval'] || 5,
          verbose: args['--verbose'] || false,
          dryRun: args['--dry-run'] || false,
          output: outputFormat
        };
        results = await watch(serviceDeployments, watchOptions);
        break;
      }
      
      case 'configure': {
        const { configure } = await import('./commands/configure.js');
        // Parse the action from positional arguments
        const action = args._?.length > 0 ? args._[0] : 'show';
        const configureOptions = {
          action: action as 'show' | 'list' | 'validate' | 'get' | 'set',
          environment: getEnvironmentWithFallback(args),
          secretPath: args['--secret-path'],
          value: args['--value'],
          verbose: args['--verbose'] || false,
          dryRun: args['--dry-run'] || false,
          output: outputFormat
        };
        results = await configure(configureOptions);
        break;
      }

      case 'init': {
        const { init } = await import('./commands/init.js');
        const initOptions = {
          name: args['--name'],
          directory: args['--directory'],
          force: args['--force'] || false,
          environments: args['--environments']?.split(',') || ['local', 'test', 'staging', 'production'],
          output: outputFormat,
          quiet: args['--quiet'] || false,
          verbose: args['--verbose'] || false,
        };
        results = await init(initOptions);
        break;
      }
      
      default:
        throw new Error(`Command '${command}' is not yet implemented`);
    }
    
    return results;
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
  
  try {
    // Execute the command
    const results = await executeCommand(command, commandArgs);
    
    // Format and output results (works for all formats including summary)
    const outputFormat = commandArgs['--output'] || 'summary';
    const { formatResults } = await import('./lib/output-formatter.js');
    const formatted = formatResults(results, outputFormat);
    console.log(formatted);
    
    // Exit with appropriate code
    if (results.summary && results.summary.failed > 0) {
      process.exit(1);
    }
  } catch (error) {
    printError(`Command failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// Run the CLI
main().catch((error) => {
  printError(`Unexpected error: ${error.message}`);
  process.exit(1);
});