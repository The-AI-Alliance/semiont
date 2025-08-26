/**
 * Start Command - New Service-based implementation
 */

import { z } from 'zod';
import { colors } from '../lib/cli-colors.js';
import { printError, printSuccess, printInfo } from '../lib/cli-logger.js';
import { type ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import { CommandResults } from '../lib/command-results.js';
import { CommandBuilder } from '../lib/command-definition.js';
import type { BaseCommandOptions } from '../lib/base-command-options.js';

// Import new service architecture
import { ServiceFactory } from '../services/service-factory.js';
import { Config, ServiceName, DeploymentType, StartResult } from '../services/types.js';

const PROJECT_ROOT = process.env.SEMIONT_ROOT || process.cwd();

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const StartOptionsSchema = z.object({
  environment: z.string().optional(),
  output: z.enum(['summary', 'table', 'json', 'yaml']).default('summary'),
  quiet: z.boolean().default(false),
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  service: z.string().optional(),
});

type StartOptions = z.infer<typeof StartOptionsSchema> & BaseCommandOptions;

// =====================================================================
// SERVICE-BASED START IMPLEMENTATION
// =====================================================================

async function startServiceImpl(
  serviceInfo: ServiceDeploymentInfo, 
  config: Config
): Promise<StartResult> {
  // Create the service instance
  const service = ServiceFactory.create(
    serviceInfo.name as ServiceName,
    serviceInfo.deploymentType as DeploymentType,
    config,
    { ...serviceInfo.config, deploymentType: serviceInfo.deploymentType as DeploymentType }
  );
  
  // Start the service
  return await service.start();
}

// =====================================================================
// MAIN START FUNCTION
// =====================================================================

export async function start(
  serviceDeployments: ServiceDeploymentInfo[],
  options: StartOptions
): Promise<CommandResults> {
  const startTime = Date.now();
  const isStructuredOutput = options.output && ['json', 'yaml', 'table'].includes(options.output);
  const environment = options.environment!; // Environment is guaranteed by command loader
  
  // Create shared config
  const config: Config = {
    projectRoot: PROJECT_ROOT,
    environment: environment as any,
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
          service: serviceInfo.name as ServiceName,
          deployment: serviceInfo.deploymentType as DeploymentType,
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
    
    // Convert service results to CommandResults format
    const formattedResults = serviceResults.map(r => ({
      command: 'start',
      service: r.service,
      deploymentType: r.deployment,
      environment: environment,
      timestamp: r.startTime,
      duration: Date.now() - r.startTime.getTime(),
      success: r.success,
      startTime: r.startTime,
      resourceId: {
        [r.deployment]: {
          pid: r.pid,
          id: r.containerId,
          endpoint: r.endpoint
        }
      } as any,
      status: r.success ? 'running' : 'failed',
      endpoint: r.endpoint,
      metadata: r.metadata || {},
      error: r.error || undefined
    }));
    
    // Create aggregated results structure
    const commandResults: CommandResults = {
      command: 'start',
      environment: environment,
      timestamp: new Date(),
      duration: Date.now() - startTime,
      services: formattedResults,
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

export const startCommand = new CommandBuilder<StartOptions>()
  .name('start')
  .description('Start services in an environment')
  .schema(StartOptionsSchema as any)
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
    },
    aliases: {
      '-e': '--environment',
      '-o': '--output',
      '-q': '--quiet',
      '-v': '--verbose',
    }
  })
  .examples(
    'semiont start --environment local',
    'semiont start --environment staging --service backend',
    'semiont start --environment prod --dry-run'
  )
  .handler(start)
  .build();

export default startCommand;
export type { StartOptions };
export { StartOptionsSchema };