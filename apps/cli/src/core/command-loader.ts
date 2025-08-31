/**
 * Command Loader - Dynamic command loading and execution
 * 
 * This module provides utilities for dynamically loading and executing
 * commands based on the unified command definition structure.
 */

import type { CommandDefinition } from './command-definition.js';
import type { ServicePlatformInfo } from './platform-resolver.js';
import { createArgParser, generateHelp } from './io/arg-parser.js';
import { 
  getAvailableEnvironments, 
  isValidEnvironment,
  resolveServiceDeployments 
} from './platform-resolver.js';
import { formatResults } from './io/output-formatter.js';
import { printError } from './io/cli-logger.js';
import { getPreamble, getPreambleSeparator } from './io/cli-colors.js';


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
    
    // Skip output for MCP to avoid corrupting JSON-RPC stream
    if (!(commandName === 'start' && options.service === 'mcp')) {
      // Format and output results
      const formatted = formatResults(results, options.output, options.verbose);
      console.log(formatted);
    }
    
    // For MCP, don't exit - let the process keep running
    if (commandName === 'start' && options.service === 'mcp') {
      // MCP process will handle its own lifecycle
      return;
    }
    
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
  lines.push('  SEMIONT_ENV                 Environment to use when --environment flag is not provided');
  lines.push('  SEMIONT_ROOT                Project root directory (parent of environments/)');
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
  lines.push('  # Watch services using environment from SEMIONT_ENV');
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