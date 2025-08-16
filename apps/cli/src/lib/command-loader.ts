/**
 * Command Loader - Dynamic command loading and execution
 * 
 * This module provides utilities for dynamically loading and executing
 * commands based on the unified command definition structure.
 */

import type { CommandDefinition } from './command-definition.js';
import type { ServiceDeploymentInfo } from './deployment-resolver.js';
import { createArgParser, generateHelp } from './arg-parser.js';
import { 
  getAvailableEnvironments, 
  isValidEnvironment,
  resolveServiceDeployments 
} from './deployment-resolver.js';
import { 
  validateServiceSelector, 
  resolveServiceSelector 
} from './services.js';
import { formatResults } from './output-formatter.js';
import { printError } from './cli-logger.js';

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
    const command = module[`${name}Command`] || module.default || module[name];
    
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
    let services: ServiceDeploymentInfo[] = [];
    if (command.requiresServices) {
      const service = (options as any).service || 'all';
      // At this point, environment is guaranteed to be defined if requiresEnvironment is true
      const environment = options.environment!;
      await validateServiceSelector(service, commandName as any, environment);
      const resolvedServices = await resolveServiceSelector(service, commandName as any, environment);
      services = resolveServiceDeployments(resolvedServices, environment);
    }
    
    // Execute the command handler
    const results = await command.handler(services, options);
    
    // Format and output results
    const formatted = formatResults(results, options.output);
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
  
  lines.push('For command-specific help:');
  lines.push('  semiont <command> --help');
  
  return lines.join('\n');
}