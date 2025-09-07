/**
 * Start Command - Unified Executor Implementation
 * 
 * Starts services across all platforms using the MultiServiceExecutor architecture.
 */

import { z } from 'zod';
import { ServicePlatformInfo } from '../service-resolver.js';
import { CommandResult, createCommandResult } from '../command-result.js';
import { CommandDescriptor, createCommandDescriptor } from '../command-descriptor.js';
import { MultiServiceExecutor } from '../multi-service-executor.js';
import { CommandBuilder } from '../command-definition.js';
import { BaseOptionsSchema } from '../base-options-schema.js';
import { Platform } from '../platform.js';
import { Service } from '../../services/types.js';
import { HandlerResult } from '../handlers/types.js';

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const StartOptionsSchema = BaseOptionsSchema.extend({
  service: z.string().optional(),
});

type StartOptions = z.output<typeof StartOptionsSchema>;

// =====================================================================
// COMMAND DESCRIPTOR
// =====================================================================

const startDescriptor: CommandDescriptor<StartOptions> = createCommandDescriptor({
  name: 'start',
  
  buildServiceConfig: (options, serviceInfo) => ({
    ...serviceInfo.config,
    platform: serviceInfo.platform,
    environment: options.environment,
  }),
  
  extractHandlerOptions: (options) => ({
    service: options.service,
    verbose: options.verbose,
    quiet: options.quiet,
    dryRun: options.dryRun,
  }),
  
  buildResult: (handlerResult: HandlerResult, service: Service, platform: Platform, serviceType: string): CommandResult => {
    // Type guard for start-specific results
    const startResult = handlerResult as any; // StartHandlerResult
    
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
      startTime: startResult.startTime,
      endpoint: startResult.endpoint,
      resources: startResult.resources,
    });
  },
  
  // Environment validation is handled by MultiServiceExecutor
  
  continueOnError: true,  // Continue starting all services even if one fails
  supportsAll: true,
});

// =====================================================================
// EXECUTOR INSTANCE
// =====================================================================

const startExecutor = new MultiServiceExecutor(startDescriptor);

// =====================================================================
// COMMAND EXPORT
// =====================================================================

/**
 * Main start command function
 */
export async function start(
  serviceDeployments: ServicePlatformInfo[],
  options: StartOptions
) {
  return startExecutor.execute(serviceDeployments, options);
}

// StartResult type alias removed - use CommandResult directly

// =====================================================================
// COMMAND DEFINITION (for CLI)
// =====================================================================

export const startCommand = new CommandBuilder()
  .name('start')
  .description('Start services on their configured platforms')
  .examples(
    'semiont start --service frontend',
    'semiont start --service backend --verbose',
    'semiont start --all'
  )
  .args({
    args: {
      '--service': {
        type: 'string',
        description: 'Service to start (or "all" for all services)',
      },
      '--all': {
        type: 'boolean',
        description: 'Start all services',
        default: false,
      },
    },
    aliases: {
      '-s': '--service',
    },
  })
  .schema(StartOptionsSchema)
  .handler(start)
  .build();