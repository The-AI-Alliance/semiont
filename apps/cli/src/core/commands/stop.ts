/**
 * Stop Command - Unified Executor Implementation
 * 
 * Stops services across all platforms using the MultiServiceExecutor architecture.
 */

import { z } from 'zod';
import { ServicePlatformInfo } from '../service-resolver.js';
import { CommandResult, createCommandResult } from '../command-result.js';
import { CommandDescriptor, createCommandDescriptor } from '../command-descriptor.js';
import { MultiServiceExecutor } from '../multi-service-executor.js';
import { CommandBuilder } from '../command-definition.js';
import { BaseOptionsSchema } from '../base-options-schema.js';
import { Platform } from '../platform.js';
import { Service } from '../service-interface.js';
import { HandlerResult } from '../handlers/types.js';

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const StopOptionsSchema = BaseOptionsSchema.extend({
  service: z.string().optional(),
  force: z.boolean().default(false).describe('Force stop without graceful shutdown'),
  timeout: z.number().default(30).describe('Timeout for graceful shutdown in seconds'),
});

type StopOptions = z.output<typeof StopOptionsSchema>;

// =====================================================================
// COMMAND DESCRIPTOR
// =====================================================================

const stopDescriptor: CommandDescriptor<StopOptions> = createCommandDescriptor({
  name: 'stop',
  
  buildServiceConfig: (options, serviceInfo) => ({
    ...serviceInfo.config,
    platform: serviceInfo.platform,
    environment: options.environment,
  }),
  
  extractHandlerOptions: (options) => ({
    service: options.service,
    force: options.force,
    timeout: options.timeout,
    verbose: options.verbose,
    quiet: options.quiet,
    dryRun: options.dryRun,
  }),
  
  buildResult: (handlerResult: HandlerResult, service: Service, platform: Platform, serviceType: string): CommandResult => {
    // Type guard for stop-specific results
    const stopResult = handlerResult as any; // StopHandlerResult
    
    return createCommandResult({
      entity: service.name,
      platform: platform.getPlatformName() as any,
      success: handlerResult.success,
      error: handlerResult.error,
      metadata: {
        ...handlerResult.metadata,
        serviceType,
      }
    }, {
      stop: {
        stopTime: stopResult.stopTime,
        graceful: stopResult.graceful,
      }
    });
  },
  
  // Environment validation is handled by MultiServiceExecutor
  
  continueOnError: true,  // Continue stopping all services even if one fails
  supportsAll: true,
});

// =====================================================================
// EXECUTOR INSTANCE
// =====================================================================

const stopExecutor = new MultiServiceExecutor(stopDescriptor);

// =====================================================================
// COMMAND EXPORT
// =====================================================================

/**
 * Main stop command function
 */
export async function stop(
  serviceDeployments: ServicePlatformInfo[],
  options: StopOptions
) {
  return stopExecutor.execute(serviceDeployments, options);
}

// =====================================================================
// COMMAND DEFINITION (for CLI)
// =====================================================================

export const stopCommand = new CommandBuilder()
  .name('stop')
  .description('Stop services on their configured platforms')
  .examples(
    'semiont stop --service frontend',
    'semiont stop --service backend --force',
    'semiont stop --all'
  )
  .args({
    args: {
      '--service': {
        type: 'string',
        description: 'Service to stop (or "all" for all services)',
      },
      '--all': {
        type: 'boolean',
        description: 'Stop all services',
        default: false,
      },
      '--force': {
        type: 'boolean',
        description: 'Force stop without graceful shutdown',
        default: false,
      },
      '--timeout': {
        type: 'number',
        description: 'Timeout for graceful shutdown in seconds',
        default: 30,
      },
    },
    aliases: {
      '-s': '--service',
      '-f': '--force',
      '-t': '--timeout',
    },
  })
  .schema(StopOptionsSchema)
  .handler(stop)
  .build();