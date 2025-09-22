/**
 * Command Executor Module → How to run them?
 * 
 * This module orchestrates the entire command execution pipeline.
 * It answers the fundamental question: "How do we execute a command?"
 * 
 * Responsibilities:
 * - Loads the command definition (via command-discovery)
 * - Parses and validates command-line arguments
 * - Validates environment requirements
 * - Resolves services if needed (via command-service-matcher)
 * - Executes the command handler with appropriate context
 * - Formats and displays output
 * - Manages process exit codes
 * 
 * Execution Pipeline:
 * 1. Load command → Parse args → Validate environment
 * 2. If services needed → Validate selector → Resolve services
 * 3. Execute handler → Format output → Exit appropriately
 * 
 * This module is the conductor that coordinates all other modules
 * to deliver the complete command execution experience.
 */

import type { ServicePlatformInfo } from './service-resolver.js';
import { loadCommand, loadAllCommands } from './command-discovery.js';
import { validateServiceSelector, resolveServiceSelector } from './command-service-matcher.js';
import { createArgParser, generateHelp } from './io/arg-parser.js';
import { getAvailableEnvironments, isValidEnvironment } from './environment-loader.js';
import { resolveServiceDeployments } from './service-resolver.js';
import { formatResults } from './io/output-formatter.js';
import { printError } from './io/cli-logger.js';
import { getPreamble, getPreambleSeparator } from './io/cli-colors.js';
import { extractCLIBehaviors, CLIBehaviors } from './service-cli-behaviors.js';
import { ServiceFactory } from '../services/service-factory.js';
import { ServiceName } from './service-discovery.js';
import { parseEnvironment } from './environment-validator.js';

/**
 * Get the CLI version from package.json
 */
function getVersion(): string {
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
 * 
 * @param commandName - The command to execute
 * @param argv - The command line arguments
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
    
    // Check if service requires special CLI behaviors
    let cliBehaviors: CLIBehaviors = {};
    if (command.requiresServices && options.service && options.service !== 'all') {
      // For single service commands, check if it needs special handling
      // We need to peek at the service requirements to determine behaviors
      if (options.environment || process.env.SEMIONT_ENV) {
        try {
          const env = options.environment || process.env.SEMIONT_ENV;
          const resolvedServices = await resolveServiceSelector(
            options.service as string, 
            commandName,
            env
          );
          const serviceDeployments = resolveServiceDeployments(resolvedServices, env);
          
          if (serviceDeployments.length > 0) {
            const deployment = serviceDeployments[0];
            const service = ServiceFactory.create(
              deployment.name as ServiceName,
              deployment.platform,
              {
                projectRoot: process.env.SEMIONT_ROOT || process.cwd(),
                environment: parseEnvironment(env),
                verbose: false,
                quiet: true,
                dryRun: false
              },
              {
                ...deployment.config,
                platform: deployment.platform
              }
            );
            const requirements = service.getRequirements();
            cliBehaviors = extractCLIBehaviors(requirements.annotations);
            
            // Apply force quiet mode if requested
            if (cliBehaviors.forceQuietMode) {
              options.quiet = true;
            }
          }
        } catch {
          // If we can't determine behaviors, continue with defaults
        }
      }
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
      await validateServiceSelector(service, commandName, environment);
      const resolvedServices = await resolveServiceSelector(service, commandName, environment);
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
    
    // Skip output if service requires it (e.g., to avoid corrupting stdio streams)
    if (!cliBehaviors.skipResultFormatting) {
      // Format and output results
      const formatted = formatResults(results, options.output, options.verbose);
      console.log(formatted);
    }
    
    // Keep process alive if service requires it (e.g., for long-running connections)
    if (cliBehaviors.keepProcessAlive) {
      // Keep the CLI process alive indefinitely
      // The child process (MCP server) will handle its own lifecycle
      // This prevents Node.js from exiting when the event loop becomes empty
      await new Promise(() => {
        // This promise never resolves, keeping the process alive
        // The process will exit when the child process exits or on SIGINT/SIGTERM
      });
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
  lines.push('  SEMIONT_REPO                Path to Semiont repository (fallback for --semiont-repo)');
  lines.push('');
  
  lines.push('PROJECT RESOLUTION:');
  lines.push('  Semiont identifies the project root using:');
  lines.push('  1. SEMIONT_ROOT environment variable (if set) - must point to valid project');
  lines.push('  2. Current working directory - must contain semiont.json or environments/');
  lines.push('');
  
  lines.push('COMMANDS:');
  
  // List all commands alphabetically without categories
  const sortedCommands = Array.from(commands.entries()).sort(([a], [b]) => a.localeCompare(b));
  
  for (const [name, command] of sortedCommands) {
    const envFlag = command.requiresEnvironment ? ' (requires -e)' : '';
    lines.push(`  ${name.padEnd(12)} ${command.description}${envFlag}`);
  }
  lines.push('');
  
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