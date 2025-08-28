/**
 * Restart Command - Simplified to delegate to platforms
 */

import { z } from 'zod';
import { printError, printSuccess, printInfo } from '../lib/cli-logger.js';
import { ServicePlatformInfo, Platform } from '../platforms/platform-resolver.js';
import { PlatformResources } from '../platforms/platform-resources.js';
import { ServiceName } from '../services/service-interface.js';
import { CommandResults } from '../commands/command-results.js';
import { CommandBuilder } from '../commands/command-definition.js';
import { BaseOptionsSchema } from '../commands/base-options-schema.js';
import { ServiceFactory } from '../services/service-factory.js';
import { PlatformFactory } from '../platforms/index.js';
import { Config } from '../lib/cli-config.js';
import { parseEnvironment } from '../lib/environment-validator.js';

// =====================================================================
// RESULT TYPE DEFINITIONS
// =====================================================================

export interface RestartResult {
  entity: ServiceName | string;
  platform: Platform;
  success: boolean;
  stopTime: Date;
  startTime: Date;
  downtime: number; // milliseconds
  gracefulRestart: boolean;
  resources?: PlatformResources;
  error?: string;
  metadata?: Record<string, any>;
}

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const RestartOptionsSchema = BaseOptionsSchema.extend({
  force: z.boolean().default(false),
  gracePeriod: z.number().int().positive().default(3), // seconds
  service: z.string().optional(),
});

type RestartOptions = z.infer<typeof RestartOptionsSchema>;

// =====================================================================
// RESTART IMPLEMENTATION
// =====================================================================

async function restartServiceImpl(
  serviceInfo: ServicePlatformInfo,
  config: Config,
  options: RestartOptions
): Promise<RestartResult> {
  const stopTime = new Date();
  
  try {
    // Get the platform strategy
    const platform = PlatformFactory.getPlatform(serviceInfo.platform);
    
    // Create service instance to act as ServiceContext
    const service = ServiceFactory.create(
      serviceInfo.name as ServiceName,
      serviceInfo.platform,
      config,
      { ...serviceInfo.config, platform: serviceInfo.platform }
    );
    
    // Stop the service
    printInfo(`Stopping ${serviceInfo.name}...`);
    const stopResult = await platform.stop(service);
    
    if (!stopResult.success) {
      return {
        entity: serviceInfo.name,
        platform: serviceInfo.platform,
        success: false,
        stopTime,
        startTime: new Date(),
        downtime: 0,
        gracefulRestart: false,
        error: `Failed to stop: ${stopResult.error}`
      };
    }
    
    // Wait for grace period
    if (options.gracePeriod > 0) {
      await new Promise(resolve => setTimeout(resolve, options.gracePeriod * 1000));
    }
    
    // Start the service
    const startTime = new Date();
    printInfo(`Starting ${serviceInfo.name}...`);
    const startResult = await platform.start(service);
    
    if (!startResult.success) {
      return {
        entity: serviceInfo.name,
        platform: serviceInfo.platform,
        success: false,
        stopTime,
        startTime,
        downtime: startTime.getTime() - stopTime.getTime(),
        gracefulRestart: true,
        error: `Failed to start: ${startResult.error}`
      };
    }
    
    return {
      entity: serviceInfo.name,
      platform: serviceInfo.platform,
      success: true,
      stopTime,
      startTime,
      downtime: startTime.getTime() - stopTime.getTime(),
      gracefulRestart: true,
      resources: startResult.resources,
      metadata: {
        ...stopResult.metadata,
        ...startResult.metadata
      }
    };
  } catch (error) {
    return {
      entity: serviceInfo.name,
      platform: serviceInfo.platform,
      success: false,
      stopTime,
      startTime: new Date(),
      downtime: 0,
      gracefulRestart: false,
      error: (error as Error).message
    };
  }
}

// =====================================================================
// COMMAND HANDLER
// =====================================================================

async function restartHandler(
  services: ServicePlatformInfo[],
  options: RestartOptions
): Promise<CommandResults<RestartResult>> {
  const startTime = Date.now();
  const results: RestartResult[] = [];
  
  // Create config
  const config: Config = {
    projectRoot: process.cwd(),
    environment: parseEnvironment(options.environment!),
    verbose: options.verbose,
    quiet: options.quiet,
    dryRun: options.dryRun
  };
  
  if (!options.quiet) {
    printInfo(`Restarting ${services.length} service(s)`);
  }
  
  // Restart each service
  for (const serviceInfo of services) {
    const result = await restartServiceImpl(serviceInfo, config, options);
    results.push(result);
    
    if (result.success) {
      printSuccess(`✓ ${serviceInfo.name} restarted (downtime: ${result.downtime}ms)`);
    } else {
      printError(`✗ ${serviceInfo.name} failed: ${result.error}`);
    }
  }
  
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  
  return {
    command: 'restart',
    environment: options.environment!,
    timestamp: new Date(),
    duration: Date.now() - startTime,
    results,
    summary: {
      total: services.length,
      succeeded: successful,
      failed: failed,
      warnings: 0
    },
    executionContext: {
      user: process.env.USER || 'unknown',
      workingDirectory: process.cwd(),
      dryRun: options.dryRun || false
    }
  };
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const restartCommand = new CommandBuilder<RestartResult>()
  .name('restart')
  .description('Restart services')
  .schema(RestartOptionsSchema)
  .requiresServices(true)
  .handler(restartHandler)
  .build();