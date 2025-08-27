/**
 * Stop Command - New Service-based implementation
 */

import { z } from 'zod';
import { colors } from '../lib/cli-colors.js';
import { printError, printSuccess, printInfo } from '../lib/cli-logger.js';
import { type ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import { CommandResults } from '../lib/command-results.js';
import { CommandBuilder } from '../lib/command-definition.js';
import { BaseOptionsSchema } from '../lib/base-options-schema.js';

// Import new service architecture
import { ServiceFactory } from '../services/service-factory.js';
import { Config, ServiceName, DeploymentType, StopResult } from '../services/types.js';
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
  serviceInfo: ServiceDeploymentInfo,
  config: Config
): Promise<StopResult> {
  // Create the service instance
  const service = ServiceFactory.create(
    serviceInfo.name as ServiceName,
    serviceInfo.deploymentType as DeploymentType,
    config,
    { ...serviceInfo.config, deploymentType: serviceInfo.deploymentType as DeploymentType }
  );
  
  // Stop the service
  return await service.stop();
}

// =====================================================================
// MAIN STOP FUNCTION
// =====================================================================

export async function stop(
  serviceDeployments: ServiceDeploymentInfo[],
  options: StopOptions
): Promise<CommandResults> {
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
          service: serviceInfo.name as ServiceName,
          deployment: serviceInfo.deploymentType as DeploymentType,
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
    
    // Convert service results to CommandResults format
    const formattedResults = serviceResults.map(r => ({
      command: 'stop',
      service: r.service,
      deploymentType: r.deployment,
      environment: environment,
      timestamp: r.stopTime,
      duration: Date.now() - r.stopTime.getTime(),
      success: r.success,
      stopTime: r.stopTime,
      gracefulShutdown: r.gracefulShutdown || false,
      forcedTermination: r.metadata?.forcedKill || false,
      resourceId: {
        [r.deployment]: r.metadata || {}
      },
      status: r.success ? 'stopped' : 'failed',
      metadata: r.metadata || {},
      error: r.error || undefined
    }));
    
    // Create aggregated results
    const commandResults: CommandResults = {
      command: 'stop',
      environment: environment,
      timestamp: new Date(),
      duration: Date.now() - stopTime,
      services: formattedResults,
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
      services: [],
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

export const stopCommand = new CommandBuilder<StopOptions>()
  .name('stop')
  .description('Stop services in an environment')
  .schema(StopOptionsSchema)
  .requiresEnvironment(true)
  .requiresServices(true)
  .args({
    args: {
      '--environment': { type: 'string', description: 'Environment name' },
      '--output': { type: 'string', description: 'Output format (summary, table, json, yaml)' },
      '--quiet': { type: 'boolean', description: 'Suppress output' },
      '--verbose': { type: 'boolean', description: 'Verbose output' },
      '--dry-run': { type: 'boolean', description: 'Simulate actions without executing' },
      '--service': { type: 'string', description: 'Service name or "all" for all services' },
      '--force': { type: 'boolean', description: 'Force stop services' },
    },
    aliases: {
      '-e': '--environment',
      '-o': '--output',
      '-q': '--quiet',
      '-v': '--verbose',
      '-f': '--force',
    }
  })
  .examples(
    'semiont stop --environment local',
    'semiont stop --environment staging --service backend',
    'semiont stop --environment prod --force'
  )
  .handler(stop)
  .build();

export default stopCommand;
export type { StopOptions };
export { StopOptionsSchema };