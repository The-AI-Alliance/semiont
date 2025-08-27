/**
 * Stop Command - New Service-based implementation
 */

import { z } from 'zod';
import { colors } from '../lib/cli-colors.js';
import { printError, printSuccess, printInfo } from '../lib/cli-logger.js';
import { type ServicePlatformInfo } from '../lib/platform-resolver.js';
import { CommandResults } from '../lib/command-results.js';
import { CommandBuilder } from '../lib/command-definition.js';
import { BaseOptionsSchema, withBaseArgs } from '../lib/base-options-schema.js';

// Import new service architecture
import { ServiceFactory } from '../services/service-factory.js';
import { ServiceName } from '../services/service-interface.js';
import { StopResult } from '../services/stop-service.js';
import { Config } from '../lib/cli-config.js';
import { parseEnvironment } from '../lib/environment-validator.js';

const PROJECT_ROOT = process.env.SEMIONT_ROOT || process.cwd();

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
  // Create the service instance
  const service = ServiceFactory.create(
    serviceInfo.name as ServiceName,
    serviceInfo.platform,
    config,
    { ...serviceInfo.config, platform: serviceInfo.platform }
  );
  
  // Stop the service
  return await service.stop();
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
    
    // Stop services in reverse order (frontend before backend, services before database)
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
    'semiont stop --environment staging --service backend',
    'semiont stop --environment prod --force'
  )
  .handler(stop)
  .build();

export type { StopOptions };
export { StopOptionsSchema };