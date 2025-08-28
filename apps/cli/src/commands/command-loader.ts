/**
 * Command Loader - Dynamic command loading and execution
 * 
 * This module provides utilities for dynamically loading and executing
 * commands based on the unified command definition structure.
 */

import type { CommandDefinition } from '../commands/command-definition.js';
import type { ServicePlatformInfo } from '../platforms/platform-resolver.js';
import { createArgParser, generateHelp } from '../commands/arg-parser.js';
import { 
  getAvailableEnvironments, 
  isValidEnvironment,
  resolveServiceDeployments 
} from '../platforms/platform-resolver.js';
import { 
  validateServiceSelector, 
  resolveServiceSelector,
  type ServiceCapability 
} from '../services/services.js';
import { formatResults } from '../commands/output-formatter.js';
import { printError } from '../lib/cli-logger.js';
import { getPreamble, getPreambleSeparator } from '../lib/cli-colors.js';

/**
 * Registry of loaded command definitions
 */
const commandRegistry = new Map<string, CommandDefinition<any>>();

/**
 * Register a command definition directly (useful for testing)
 */
export function registerCommand(name: string, command: CommandDefinition<any>): void {
  commandRegistry.set(name, command);
}

/**
 * Load a command definition from its module
 */
export async function loadCommand(name: string): Promise<CommandDefinition<any>> {
  // Check cache first
  if (commandRegistry.has(name)) {
    return commandRegistry.get(name)!;
  }
  
  try {
    // For testing or when dynamic imports don't work, try direct imports
    let module: any;
    
    // Handle special cases for known commands
    if (name === 'init') {
      module = await import('../commands/init.js');
    } else if (name === 'backup') {
      module = await import('../commands/backup.js');
    } else if (name === 'start') {
      module = await import('../commands/start.js');
    } else if (name === 'stop') {
      module = await import('../commands/stop.js');
    } else if (name === 'restart') {
      module = await import('../commands/restart.js');
    } else if (name === 'check') {
      module = await import('../commands/check.js');
    } else if (name === 'configure') {
      module = await import('../commands/configure.js');
    } else if (name === 'exec') {
      module = await import('../commands/exec.js');
    } else if (name === 'provision') {
      module = await import('../commands/provision.js');
    } else if (name === 'publish') {
      module = await import('../commands/publish.js');
    } else if (name === 'test') {
      module = await import('../commands/test.js');
    } else if (name === 'update') {
      module = await import('../commands/update.js');
    } else if (name === 'watch') {
      module = await import('../commands/watch.js');
    } else {
      throw new Error(`Command '${name}' not found`);
    }
    
    // Look for the command export (could be named export or default)
    // Handle hyphenated command names by converting to camelCase for the export name
    const camelName = name.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
    const command = module[`${camelName}Command`] || module.default || module[name];
    
    if (!command) {
      throw new Error(`Command module does not export '${name}Command', 'default', or '${name}'`);
    }
    
    // Validate it's a proper command definition
    if (!isCommandDefinition(command)) {
      throw new Error(`Exported command does not match CommandDefinition interface`);
    }
    
    // Cache for future use
    commandRegistry.set(name, command);
    
    return command;
  } catch (error) {
    if (error instanceof Error && error.message.includes('Cannot find module')) {
      throw new Error(`Command '${name}' not found`);
    }
    if (error instanceof Error && error.message.includes("Command '") && error.message.includes("' not found")) {
      throw error; // Re-throw our own not found errors
    }
    throw error;
  }
}

/**
 * Type guard to check if an object is a CommandDefinition
 */
function isCommandDefinition(obj: any): obj is CommandDefinition<any> {
  return (
    obj &&
    typeof obj === 'object' &&
    typeof obj.name === 'string' &&
    typeof obj.description === 'string' &&
    obj.schema &&
    obj.argSpec &&
    typeof obj.handler === 'function'
  );
}

/**
 * Get the CLI version from package.json
 */
function getVersion(): string {
  // Simple approach: require the package.json which will be bundled
  // @ts-ignore - TypeScript doesn't like importing JSON, but esbuild handles it fine
  const pkg = require('../../package.json');
  return pkg.version || '0.0.1';
}

/**
 * Print the Semiont preamble for non-quiet, summary output
 */
function printPreamble(options: any): void {
  // Only print preamble for summary output format and when not quiet
  if (options.output !== 'summary' && options.output !== undefined) {
    return;
  }
  if (options.quiet === true) {
    return;
  }
  
  // Get version (embedded at build time)
  const version = getVersion();
  
  // Print the preamble with colors
  console.log(getPreamble(version));
  console.log(getPreambleSeparator());
}

/**
 * Execute a command with full lifecycle management
 */
export async function executeCommand(
  commandName: string,
  argv: string[]
): Promise<void> {
  try {
    // Load the command definition
    const command = await loadCommand(commandName);
    
    // Handle help flag
    if (argv.includes('--help') || argv.includes('-h')) {
      console.log(generateHelp(command));
      process.exit(0);
    }
    
    // Parse and validate arguments
    const parser = createArgParser(command);
    const options = parser(argv);
    
    // Suppress preamble for MCP service to ensure clean JSON-RPC communication
    if (commandName === 'start' && options.service === 'mcp') {
      options.quiet = true;
    }
    
    // Print preamble for summary output (before any command output)
    printPreamble(options);
    
    // Validate environment if required
    if (command.requiresEnvironment) {
      // Check for environment from --environment flag or SEMIONT_ENV variable
      if (!options.environment) {
        const envFromVariable = process.env.SEMIONT_ENV;
        if (envFromVariable) {
          options.environment = envFromVariable;
        } else {
          const availableEnvs = getAvailableEnvironments();
          throw new Error(
            `Environment not specified. Use --environment flag or set SEMIONT_ENV environment variable. ` +
            `Available: ${availableEnvs.length > 0 ? availableEnvs.join(', ') : 'none found'}`
          );
        }
      }
      
      if (!isValidEnvironment(options.environment)) {
        const availableEnvs = getAvailableEnvironments();
        throw new Error(
          `Unknown environment '${options.environment}'. ` +
          `Available: ${availableEnvs.join(', ')}`
        );
      }
    }
    
    // Resolve services if required
    let services: ServicePlatformInfo[] = [];
    if (command.requiresServices) {
      // Service property is optional in options, default to 'all' if not specified
      const service = 'service' in options && typeof options.service === 'string' 
        ? options.service 
        : 'all';
      // At this point, environment is guaranteed to be defined if requiresEnvironment is true
      const environment = options.environment!;
      await validateServiceSelector(service, commandName as ServiceCapability, environment);
      const resolvedServices = await resolveServiceSelector(service, commandName as ServiceCapability, environment);
      services = resolveServiceDeployments(resolvedServices, environment);
    }
    
    // Execute the command handler based on its type
    let results;
    if (command.requiresServices) {
      // Service command - pass services and options
      results = await command.handler(services, options);
    } else {
      // Setup command - pass only options
      const setupHandler = command.handler as any; // TypeScript needs help here
      results = await setupHandler(options);
    }
    
    // Format and output results
    const formatted = formatResults(results, options.output, options.verbose);
    console.log(formatted);
    
    // Exit with appropriate code
    if (results.summary && results.summary.failed > 0) {
      process.exit(1);
    }
  } catch (error) {
    if (error instanceof Error) {
      printError(error.message);
    } else {
      printError(String(error));
    }
    process.exit(1);
  }
}

/**
 * Get all available command names
 */
export async function getAvailableCommands(): Promise<string[]> {
  // This could be made more dynamic by scanning the commands directory
  // For now, return the known commands
  return [
    'init',
    'provision',
    'configure',
    'start',
    'stop',
    'restart',
    'publish',
    'update',
    'check',
    'watch',
    'test',
    'backup',
    'exec',
  ];
}

/**
 * Load all commands and return their definitions
 */
export async function loadAllCommands(): Promise<Map<string, CommandDefinition<any>>> {
  const commands = await getAvailableCommands();
  const definitions = new Map<string, CommandDefinition<any>>();
  
  for (const name of commands) {
    try {
      const command = await loadCommand(name);
      definitions.set(name, command);
    } catch (error) {
      // Skip commands that can't be loaded
      console.warn(`Warning: Could not load command '${name}': ${error}`);
    }
  }
  
  return definitions;
}

/**
 * Generate help text for all commands
 */
export async function generateGlobalHelp(): Promise<string> {
  const commands = await loadAllCommands();
  const lines: string[] = [];
  
  lines.push('Semiont CLI - Container and Cloud Management Tool');
  lines.push('');
  lines.push('USAGE:');
  lines.push('  semiont <command> [options]');
  lines.push('');
  
  lines.push('COMMON PARAMETERS:');
  lines.push('  -e, --environment <name>   Target environment (required for most commands)');
  lines.push('  -s, --service <name>        Target service or "all" for all services');
  lines.push('  -v, --verbose               Enable verbose output');
  lines.push('  -o, --output <format>       Output format: summary, table, json, yaml');
  lines.push('  --dry-run                   Simulate actions without executing');
  lines.push('  --semiont-repo <path>       Path to Semiont repository (for build commands)');
  lines.push('  --help                      Show help for a command');
  lines.push('');
  
  lines.push('ENVIRONMENT VARIABLES:');
  lines.push('  SEMIONT_ENV                 Default environment (overrides --environment flag)');
  lines.push('  SEMIONT_ROOT                Project root directory (parent of config/)');
  lines.push('  AWS_PROFILE                 AWS profile to use for AWS operations');
  lines.push('  AWS_REGION                  AWS region (overrides config file)');
  lines.push('');
  
  lines.push('PROJECT RESOLUTION:');
  lines.push('  Semiont looks for configuration in the following order:');
  lines.push('  1. SEMIONT_ROOT/environments/<env>.json (if set)');
  lines.push('  2. Current directory: ./environments/<env>.json');
  lines.push('  3. Parent directories (walks up looking for semiont.json)');
  lines.push('  4. Environment files: ./environments/<env>.json');
  lines.push('  5. For build commands: use --semiont-repo to specify the repository path');
  lines.push('');
  
  lines.push('COMMANDS:');
  
  // Group commands by category
  const categories = {
    'Infrastructure': ['init', 'provision', 'configure'],
    'Service Lifecycle': ['start', 'stop', 'restart'],
    'Deployment': ['publish', 'update'],
    'Monitoring': ['check', 'watch', 'test'],
    'Utilities': ['backup', 'exec'],
  };
  
  for (const [category, commandNames] of Object.entries(categories)) {
    lines.push(`  ${category}:`);
    
    for (const name of commandNames) {
      const command = commands.get(name);
      if (command) {
        const envFlag = command.requiresEnvironment ? ' (requires -e)' : '';
        lines.push(`    ${name.padEnd(12)} ${command.description}${envFlag}`);
      }
    }
    lines.push('');
  }
  
  lines.push('EXAMPLES:');
  lines.push('  # Initialize a new project');
  lines.push('  semiont init');
  lines.push('');
  lines.push('  # Provision infrastructure for production');
  lines.push('  semiont provision -e production');
  lines.push('');
  lines.push('  # Build and publish frontend with custom repo path');
  lines.push('  semiont publish -e production --service frontend --semiont-repo ~/repos/semiont');
  lines.push('');
  lines.push('  # Watch services using default environment from SEMIONT_ENV');
  lines.push('  export SEMIONT_ENV=staging');
  lines.push('  semiont watch');
  lines.push('');
  lines.push('  # Check health with JSON output');
  lines.push('  semiont check -e production -o json');
  lines.push('');
  
  lines.push('For command-specific help:');
  lines.push('  semiont <command> --help');
  lines.push('');
  lines.push('Documentation: https://github.com/The-AI-Alliance/semiont');
  
  return lines.join('\n');
}