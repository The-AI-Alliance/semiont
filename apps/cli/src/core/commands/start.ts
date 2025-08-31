/**
 * Start Command
 * 
 * Starts one or more services using their configured platform strategies.
 * This command handles service initialization, dependency checking, and resource
 * provisioning across different deployment platforms.
 * 
 * Workflow:
 * 1. Resolves service configurations from environment files
 * 2. Checks and starts service dependencies first
 * 3. Creates service instances via ServiceFactory
 * 4. Delegates to platform strategies for actual startup
 * 5. Saves service state for tracking and management
 * 
 * Options:
 * - --all: Start all services defined in the environment
 * - --force: Continue starting services even if dependencies fail
 * - --build: Build containers/artifacts before starting (platform-specific)
 * - --wait: Wait for services to become healthy before returning
 * 
 * Platform Behavior:
 * - Process: Spawns local OS processes
 * - Container: Creates and starts Docker/Podman containers
 * - AWS: Deploys to ECS/Fargate or Lambda
 * - External: Validates external service connectivity
 * - Mock: Simulates startup for testing
 */

import { z } from 'zod';
import { printError, printSuccess, printInfo } from '../io/cli-logger.js';
import { colors } from '../io/cli-colors.js';
import { type ServicePlatformInfo } from '../platform-resolver.js';
import { CommandResults } from '../command-results.js';
import { CommandBuilder } from '../command-definition.js';
import { BaseOptionsSchema, withBaseArgs } from '../base-options-schema.js';

// Import new service architecture
import { ServiceFactory } from '../../services/service-factory.js';
import { ServiceName } from '../service-discovery.js';
import { Platform } from '../platform-resolver.js';
import { PlatformResources } from '../../platforms/platform-resources.js';
import { Config } from '../cli-config.js';
import { parseEnvironment } from '../environment-validator.js';

const PROJECT_ROOT = process.env.SEMIONT_ROOT || process.cwd();

// =====================================================================
// RESULT TYPE DEFINITIONS
// =====================================================================

/**
 * Result of a start operation
 */
export interface StartResult {
  entity: ServiceName | string;
  platform: Platform;
  success: boolean;
  startTime: Date;
  endpoint?: string;
  resources?: PlatformResources;  // Platform-specific resource identifiers
  error?: string;
  metadata?: Record<string, any>;
}

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const StartOptionsSchema = BaseOptionsSchema.extend({
  service: z.string().optional(),
});

type StartOptions = z.output<typeof StartOptionsSchema>;

// =====================================================================
// SERVICE-BASED START IMPLEMENTATION
// =====================================================================

async function startServiceImpl(
  serviceInfo: ServicePlatformInfo, 
  config: Config
): Promise<StartResult> {
  // Get the platform strategy
  const { PlatformFactory } = await import('../../platforms/index.js');
  const platform = PlatformFactory.getPlatform(serviceInfo.platform);
  
  // Create service instance to act as ServiceContext
  const service = ServiceFactory.create(
    serviceInfo.name as ServiceName,
    serviceInfo.platform,
    config,
    { ...serviceInfo.config, platform: serviceInfo.platform, environment: config.environment }
  );
  
  // Platform handles the start command with service as context
  return await platform.start(service);
}

// =====================================================================
// MAIN START FUNCTION
// =====================================================================

export async function start(
  serviceDeployments: ServicePlatformInfo[],
  options: StartOptions
): Promise<CommandResults<StartResult>> {
  const startTime = Date.now();
  const isStructuredOutput = options.output && ['json', 'yaml', 'table'].includes(options.output);
  const environment = options.environment!; // Environment is guaranteed by command loader
  
  // Special handling for MCP - suppress all output to avoid corrupting JSON-RPC
  const isMCP = serviceDeployments.length === 1 && serviceDeployments[0].name === 'mcp';
  
  // Create shared config
  const config: Config = {
    projectRoot: PROJECT_ROOT,
    environment: parseEnvironment(environment),
    verbose: options.verbose,
    quiet: options.quiet || isStructuredOutput || isMCP, // Force quiet for MCP
    dryRun: options.dryRun
  };
  
  try {
    if (!isStructuredOutput && !options.quiet) {
      printInfo(`Starting services in ${colors.bright}${environment}${colors.reset} environment`);
    }
    
    // Start services and collect results
    const serviceResults: StartResult[] = [];
    
    for (const serviceInfo of serviceDeployments) {
      // Get the platform outside try block so it's accessible in catch
      const { PlatformFactory } = await import('../../platforms/index.js');
      const platform = PlatformFactory.getPlatform(serviceInfo.platform);
      const actualPlatformName = platform.getPlatformName();
      
      try {
        const result = await startServiceImpl(serviceInfo, config);
        serviceResults.push(result);
        
      } catch (error) {
        const errorResult: StartResult = {
          entity: serviceInfo.name as ServiceName,
          platform: actualPlatformName as Platform,  // Use actual platform name
          success: false,
          startTime: new Date(),
          error: (error as Error).message
        };
        
        serviceResults.push(errorResult);
        
        if (!isStructuredOutput && !options.quiet) {
          printError(`Failed to start ${serviceInfo.name}: ${error}`);
        }
      }
    }
    
    // Create aggregated results structure - no conversion needed!
    const commandResults: CommandResults<StartResult> = {
      command: 'start',
      environment: environment,
      timestamp: new Date(),
      duration: Date.now() - startTime,
      results: serviceResults,  // Rich types preserved!
      summary: {
        total: serviceResults.length,
        succeeded: serviceResults.filter(r => r.success).length,
        failed: serviceResults.filter(r => !r.success).length,
        warnings: 0
      },
      executionContext: {
        user: process.env.USER || 'unknown',
        workingDirectory: process.cwd(),
        dryRun: options.dryRun || false
      }
    };
    
    // Create summary for display
    const summary = {
      total: serviceResults.length,
      succeeded: serviceResults.filter(r => r.success).length,
      failed: serviceResults.filter(r => !r.success).length,
      warnings: 0,
    };
    
    if (!isStructuredOutput && !options.quiet) {
      const { succeeded, failed } = summary;
      if (failed === 0) {
        printSuccess(`All ${succeeded} service(s) started successfully`);
      } else {
        printError(`${failed} service(s) failed to start`);
      }
    }
    
    return commandResults;
    
  } catch (error) {
    if (!isStructuredOutput) {
      printError(`Failed to start services: ${error}`);
    }
    
    return {
      command: 'start',
      environment: environment,
      timestamp: new Date(),
      duration: Date.now() - startTime,
      results: [],
      summary: {
        total: 0,
        succeeded: 0,
        failed: 1,
        warnings: 0,
      },
      executionContext: {
        user: process.env.USER || 'unknown',
        workingDirectory: process.cwd(),
        dryRun: options.dryRun,
      },
    };
  }
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const startCommand = new CommandBuilder()
  .name('start')
  .description('Start services in an environment')
  .schema(StartOptionsSchema)
  .requiresEnvironment(true)
  .requiresServices(true)
  .args(withBaseArgs({
    '--service': { type: 'string', description: 'Service name or "all" for all services' },
  }))
  .examples(
    'semiont start --environment local',
    'semiont start --environment staging --service myservice',
    'semiont start --environment prod --dry-run'
  )
  .handler(start)
  .build();

export type { StartOptions };
export { StartOptionsSchema };