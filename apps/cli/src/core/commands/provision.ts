/**
 * Provision Command - Unified Executor Implementation
 * 
 * Provisions infrastructure and resources for services
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

const ProvisionOptionsSchema = BaseOptionsSchema.extend({
  service: z.string().optional(),
  all: z.boolean().default(false),
  stack: z.enum(['data', 'app', 'all']).optional(),  // AWS-specific stack provisioning
  force: z.boolean().default(false),
  skipValidation: z.boolean().default(false),
  destroy: z.boolean().default(false),
});

type ProvisionOptions = z.output<typeof ProvisionOptionsSchema>;

// =====================================================================
// COMMAND DESCRIPTOR
// =====================================================================

const provisionDescriptor: CommandDescriptor<ProvisionOptions> = createCommandDescriptor({
  name: 'provision',
  
  // Pre-execution hook to handle synthetic stack service
  preExecute: async (serviceDeployments, options) => {
    // If --stack is specified, create a synthetic service for AWS stack provisioning
    if (options.stack) {
      const stackService: ServicePlatformInfo = {
        name: '__aws_stack__',  // Special synthetic service name
        platform: 'aws',
        config: {
          // Pass stack-specific options through generic config
          // The handler will extract these from context.options
          verbose: options.verbose,
          quiet: options.quiet,
        } as any  // ServiceConfig doesn't have stack-specific fields
      };
      // Replace all services with the synthetic stack service
      return [stackService];
    }
    // Otherwise use normal services
    return serviceDeployments;
  },
  
  buildServiceConfig: (options, serviceInfo) => ({
    ...serviceInfo.config,
    platform: serviceInfo.platform,
    environment: options.environment,
    stackType: options.stack,
    force: options.force,
    skipValidation: options.skipValidation,
    destroy: options.destroy,
  }),
  
  extractHandlerOptions: (options) => ({
    stack: options.stack,
    force: options.force,
    skipValidation: options.skipValidation,
    destroy: options.destroy,
    verbose: options.verbose,
    quiet: options.quiet,
    dryRun: options.dryRun,
  }),
  
  buildResult: (handlerResult: HandlerResult, service: Service, platform: PlatformStrategy, serviceType: string): CommandResult => {
    // Type guard for provision-specific results
    const provisionResult = handlerResult as any; // ProvisionHandlerResult
    
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
      provisionedResources: provisionResult.provisionedResources,
      stackOutputs: provisionResult.stackOutputs,
      resources: provisionResult.resources,
    });
  },
  
  validateOptions: (options) => {
    // Environment validation is handled by UnifiedExecutor
    if (options.stack && options.service) {
      throw new Error('Cannot specify both --stack and --service');
    }
    if (options.stack && options.all) {
      throw new Error('Cannot specify both --stack and --all');
    }
  },
  
  continueOnError: true,  // Continue provisioning all services even if one fails
  supportsAll: true,
});

// =====================================================================
// EXECUTOR INSTANCE
// =====================================================================

const provisionExecutor = new UnifiedExecutor(provisionDescriptor);

// =====================================================================
// COMMAND EXPORT
// =====================================================================

/**
 * Main provision command function
 */
export async function provision(
  serviceDeployments: ServicePlatformInfo[],
  options: ProvisionOptions
) {
  return provisionExecutor.execute(serviceDeployments, options);
}

// ProvisionResult type alias removed - use CommandResult directly

// =====================================================================
// COMMAND DEFINITION (for CLI)
// =====================================================================

export const provisionCommand = new CommandBuilder()
  .name('provision')
  .description('Provision infrastructure and resources for services')
  .examples(
    'semiont provision --service frontend',
    'semiont provision --all',
    'semiont provision --stack data',
    'semiont provision --stack app --force'
  )
  .schema(ProvisionOptionsSchema)
  .handler(provision)
  .build();