/**
 * Stop Command
 * 
 * Gracefully stops running services and cleans up their resources.
 * This command handles service shutdown, resource deallocation, and state cleanup
 * across different deployment platforms.
 * 
 * Workflow:
 * 1. Loads service state to identify running instances
 * 2. Sends shutdown signals to services
 * 3. Waits for graceful termination (configurable timeout)
 * 4. Forces termination if needed
 * 5. Cleans up resources and removes state files
 * 
 * Options:
 * - --all: Stop all running services
 * - --force: Force immediate termination without graceful shutdown
 * - --timeout: Maximum time to wait for graceful shutdown (seconds)
 * - --keep-state: Preserve state files after stopping
 * 
 * Platform Behavior:
 * - Process: Sends SIGTERM, then SIGKILL after timeout
 * - Container: Stops containers, optionally removes them
 * - AWS: Stops ECS tasks or Lambda functions
 * - External: Marks services as stopped in registry
 * - Mock: Simulates shutdown for testing
 */

import { z } from 'zod';
import { colors } from '../lib/cli-colors.js';
import { printError, printSuccess, printInfo } from '../lib/cli-logger.js';
import { type ServicePlatformInfo } from '../platforms/platform-resolver.js';
import { CommandResults } from '../commands/command-results.js';
import { CommandBuilder } from '../commands/command-definition.js';
import { BaseOptionsSchema, withBaseArgs } from '../commands/base-options-schema.js';

// Import new service architecture
import { ServiceFactory } from '../services/service-factory.js';
import { ServiceName } from '../services/service-interface.js';
import { Config } from '../lib/cli-config.js';
import { parseEnvironment } from '../lib/environment-validator.js';
import type { Platform } from '../platforms/platform-resolver.js';
import type { PlatformResources } from '../platforms/platform-resources.js';

const PROJECT_ROOT = process.env.SEMIONT_ROOT || process.cwd();

// =====================================================================
// RESULT TYPE DEFINITIONS
// =====================================================================

/**
 * Result of a stop operation
 */
export interface StopResult {
  entity: ServiceName | string;
  platform: Platform;
  success: boolean;
  stopTime: Date;
  gracefulShutdown?: boolean;
  resources?: PlatformResources;  // Resources that were stopped
  error?: string;
  metadata?: Record<string, any>;
}

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const StopOptionsSchema = BaseOptionsSchema.extend({
  service: z.string().optional(),
  force: z.boolean().default(false),
});

type StopOptions = z.output<typeof StopOptionsSchema>;

// =====================================================================
// SERVICE-BASED STOP IMPLEMENTATION
// =====================================================================

async function stopServiceImpl(
  serviceInfo: ServicePlatformInfo,
  config: Config
): Promise<StopResult> {
  // Get the platform strategy
  const { PlatformFactory } = await import('../platforms/index.js');
  const platform = PlatformFactory.getPlatform(serviceInfo.platform);
  
  // Create service instance to act as ServiceContext
  const service = ServiceFactory.create(
    serviceInfo.name as ServiceName,
    serviceInfo.platform,
    config,
    { ...serviceInfo.config, platform: serviceInfo.platform }
  );
  
  // Platform handles the stop command with service as context
  return await platform.stop(service);
}

// =====================================================================
// MAIN STOP FUNCTION
// =====================================================================

export async function stop(
  serviceDeployments: ServicePlatformInfo[],
  options: StopOptions
): Promise<CommandResults<StopResult>> {
  const stopTime = Date.now();
  const isStructuredOutput = options.output && ['json', 'yaml', 'table'].includes(options.output);
  const environment = options.environment!; // Environment is guaranteed by command loader
  
  // Create shared config
  const config: Config = {
    projectRoot: PROJECT_ROOT,
    environment: parseEnvironment(environment),
    verbose: options.verbose,
    quiet: options.quiet || isStructuredOutput,
    dryRun: options.dryRun
  };
  
  try {
    if (!isStructuredOutput && !options.quiet) {
      printInfo(`Stopping services in ${colors.bright}${environment}${colors.reset} environment`);
    }
    
    // Stop services in reverse order
    const reversedDeployments = [...serviceDeployments].reverse();
    
    // Stop services and collect results
    const serviceResults: StopResult[] = [];
    
    for (const serviceInfo of reversedDeployments) {
      try {
        const result = await stopServiceImpl(serviceInfo, config);
        serviceResults.push(result);
        
      } catch (error) {
        const errorResult: StopResult = {
          entity: serviceInfo.name as ServiceName,
          platform: serviceInfo.platform,
          success: false,
          stopTime: new Date(),
          error: (error as Error).message
        };
        
        serviceResults.push(errorResult);
        
        if (!isStructuredOutput && !options.quiet) {
          printError(`Failed to stop ${serviceInfo.name}: ${error}`);
        }
      }
    }
    
    // Create aggregated results - no conversion needed!
    const commandResults: CommandResults<StopResult> = {
      command: 'stop',
      environment: environment,
      timestamp: new Date(),
      duration: Date.now() - stopTime,
      results: serviceResults,  // Rich types preserved!
      summary: {
        total: serviceResults.length,
        succeeded: serviceResults.filter(r => r.success).length,
        failed: serviceResults.filter(r => !r.success).length,
        warnings: 0,
      },
      executionContext: {
        user: process.env.USER || 'unknown',
        workingDirectory: process.cwd(),
        dryRun: options.dryRun,
      }
    };
    
    if (!isStructuredOutput && !options.quiet) {
      const { succeeded, failed } = commandResults.summary;
      if (failed === 0) {
        printSuccess(`All ${succeeded} service(s) stopped successfully`);
      } else {
        printError(`${failed} service(s) failed to stop`);
      }
    }
    
    return commandResults;
    
  } catch (error) {
    if (!isStructuredOutput) {
      printError(`Failed to stop services: ${error}`);
    }
    
    return {
      command: 'stop',
      environment: environment,
      timestamp: new Date(),
      duration: Date.now() - stopTime,
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

export const stopCommand = new CommandBuilder()
  .name('stop')
  .description('Stop services in an environment')
  .schema(StopOptionsSchema)
  .requiresEnvironment(true)
  .requiresServices(true)
  .args(withBaseArgs({
    '--service': { type: 'string', description: 'Service name or "all" for all services' },
    '--force': { type: 'boolean', description: 'Force stop services' },
  }, {
    '-f': '--force',
  }))
  .examples(
    'semiont stop --environment local',
    'semiont stop --environment staging --service myservice',
    'semiont stop --environment prod --force'
  )
  .handler(stop)
  .build();

export type { StopOptions };
export { StopOptionsSchema };