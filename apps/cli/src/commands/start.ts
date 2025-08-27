/**
 * Start Command - New Service-based implementation
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
import { Config, ServiceName, Platform, StartResult } from '../services/types.js';
import { parseEnvironment } from '../lib/environment-validator.js';

const PROJECT_ROOT = process.env.SEMIONT_ROOT || process.cwd();

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
  // Create the service instance
  const service = ServiceFactory.create(
    serviceInfo.name as ServiceName,
    serviceInfo.platform as Platform,
    config,
    { ...serviceInfo.config, platform: serviceInfo.platform as Platform }
  );
  
  // Start the service
  return await service.start();
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
      printInfo(`Starting services in ${colors.bright}${environment}${colors.reset} environment`);
    }
    
    // Start services and collect results
    const serviceResults: StartResult[] = [];
    
    for (const serviceInfo of serviceDeployments) {
      try {
        const result = await startServiceImpl(serviceInfo, config);
        serviceResults.push(result);
        
      } catch (error) {
        const errorResult: StartResult = {
          entity: serviceInfo.name as ServiceName,
          platform: serviceInfo.platform as Platform,
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
    'semiont start --environment staging --service backend',
    'semiont start --environment prod --dry-run'
  )
  .handler(start)
  .build();

export type { StartOptions };
export { StartOptionsSchema };