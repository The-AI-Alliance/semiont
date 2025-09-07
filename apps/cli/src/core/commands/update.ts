/**
 * Update Command - Unified Executor Implementation
 * 
 * Deploys new versions of services that have been previously published.
 * 
 * For containerized services (e.g., ECS):
 * - Checks for newer task definition revisions (created by 'publish' command)
 * - If found: Updates the service to use the newer revision
 * - If not found: Forces a redeployment of the current revision (useful for mutable tags like ':latest')
 * - Monitors the deployment progress and reports success/failure
 * 
 * The update command performs the actual deployment of artifacts prepared by 'publish'.
 * 
 * Typical workflow:
 * 1. 'semiont publish --service frontend' - Builds and pushes new image, creates task definition
 * 2. 'semiont update --service frontend' - Deploys the new task definition to the running service
 * 
 * For services using mutable tags (e.g., ':latest'), update can also force a redeployment
 * to pull the latest image even without a new task definition.
 */

import { z } from 'zod';
import { ServicePlatformInfo } from '../platform-resolver.js';
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
  
  buildResult: (handlerResult: HandlerResult, service: Service, platform: Platform, serviceType: string): CommandResult => {
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
    // Environment validation is handled by MultiServiceExecutor
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

const updateExecutor = new MultiServiceExecutor(updateDescriptor);

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
  .args({
    args: {
      '--service': {
        type: 'string',
        description: 'Service to update (or "all" for all services)',
      },
      '--all': {
        type: 'boolean',
        description: 'Update all services',
        default: false,
      },
      '--force': {
        type: 'boolean',
        description: 'Force update without prompts',
        default: false,
      },
      '--wait': {
        type: 'boolean',
        description: 'Wait for update to complete',
        default: false,
      },
      '--timeout': {
        type: 'number',
        description: 'Timeout in seconds when using --wait',
      },
      '--skip-tests': {
        type: 'boolean',
        description: 'Skip running tests during update',
        default: false,
      },
      '--skip-build': {
        type: 'boolean',
        description: 'Skip building during update',
        default: false,
      },
      '--grace-period': {
        type: 'number',
        description: 'Grace period in seconds for graceful shutdown',
      },
    },
    aliases: {
      '-s': '--service',
    },
  })
  .schema(UpdateOptionsSchema)
  .handler(update)
  .build();