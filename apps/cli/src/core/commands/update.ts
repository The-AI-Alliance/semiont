/**
 * Update Command - Unified Executor Implementation
 * 
 * Updates running services with new versions or configurations
 * using the UnifiedExecutor architecture.
 */

import { z } from 'zod';
import { ServicePlatformInfo } from '../platform-resolver.js';
import { CommandResult, createCommandResult } from '../command-result.js';
import { CommandDescriptor, createCommandDescriptor } from '../command-descriptor.js';
import { UnifiedExecutor } from '../unified-executor.js';
import { CommandBuilder } from '../command-definition.js';
import { BaseOptionsSchema } from '../base-options-schema.js';
import { PlatformStrategy } from '../platform-strategy.js';
import { Service } from '../../services/types.js';
import { HandlerResult } from '../handlers/types.js';

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const UpdateOptionsSchema = BaseOptionsSchema.extend({
  service: z.string().optional(),
  force: z.boolean().default(false),
  wait: z.boolean().default(false),
  timeout: z.number().optional(),
  skipTests: z.boolean().default(false),
  skipBuild: z.boolean().default(false),
  gracePeriod: z.number().optional(),
});

type UpdateOptions = z.output<typeof UpdateOptionsSchema>;

// =====================================================================
// COMMAND DESCRIPTOR
// =====================================================================

const updateDescriptor: CommandDescriptor<UpdateOptions> = createCommandDescriptor({
  name: 'update',
  
  buildServiceConfig: (options, serviceInfo) => ({
    ...serviceInfo.config,
    platform: serviceInfo.platform,
    environment: options.environment,
    force: options.force,
    wait: options.wait,
    timeout: options.timeout,
    skipTests: options.skipTests,
    skipBuild: options.skipBuild,
    gracePeriod: options.gracePeriod,
  }),
  
  extractHandlerOptions: (options) => ({
    force: options.force,
    wait: options.wait,
    timeout: options.timeout,
    skipTests: options.skipTests,
    skipBuild: options.skipBuild,
    gracePeriod: options.gracePeriod,
    verbose: options.verbose,
    quiet: options.quiet,
    dryRun: options.dryRun,
  }),
  
  buildResult: (handlerResult: HandlerResult, service: Service, platform: PlatformStrategy, serviceType: string): CommandResult => {
    // Type guard for update-specific results
    const updateResult = handlerResult as any; // UpdateHandlerResult
    
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
      previousVersion: updateResult.previousVersion,
      newVersion: updateResult.newVersion,
      strategy: updateResult.strategy || 'none',
      downtime: updateResult.downtime,
      resources: updateResult.resources,
    });
  },
  
  validateOptions: (options) => {
    // Environment validation is handled by UnifiedExecutor
    if (options.timeout && options.timeout < 0) {
      throw new Error('Timeout must be a positive number');
    }
    if (options.gracePeriod && options.gracePeriod < 0) {
      throw new Error('Grace period must be a positive number');
    }
  },
  
  continueOnError: true,  // Continue updating all services even if one fails
  supportsAll: true,
});

// =====================================================================
// EXECUTOR INSTANCE
// =====================================================================

const updateExecutor = new UnifiedExecutor(updateDescriptor);

// =====================================================================
// COMMAND EXPORT
// =====================================================================

/**
 * Main update command function
 */
export async function update(
  serviceDeployments: ServicePlatformInfo[],
  options: UpdateOptions
) {
  return updateExecutor.execute(serviceDeployments, options);
}

// UpdateResult type alias removed - use CommandResult directly

// =====================================================================
// COMMAND DEFINITION (for CLI)
// =====================================================================

export const updateCommand = new CommandBuilder()
  .name('update')
  .description('Update running services with new versions')
  .examples(
    'semiont update --service frontend --force',
    'semiont update --service backend --wait --timeout 300',
    'semiont update --all --skip-tests'
  )
  .schema(UpdateOptionsSchema)
  .handler(update)
  .build();