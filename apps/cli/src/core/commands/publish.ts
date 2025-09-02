/**
 * Publish Command - Unified Executor Implementation
 * 
 * Publishes services to their respective registries (Docker Hub, ECR, npm, etc.)
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

const PublishOptionsSchema = BaseOptionsSchema.extend({
  service: z.string().optional(),
  all: z.boolean().default(false),
  tag: z.string().optional(),  // Custom version tag
  registry: z.string().optional(),  // Override default registry
  semiontRepo: z.string().optional(),  // Path to Semiont repository for builds
  noCache: z.boolean().optional().default(false),  // Skip Docker cache
});

type PublishOptions = z.output<typeof PublishOptionsSchema>;

// =====================================================================
// COMMAND DESCRIPTOR
// =====================================================================

const publishDescriptor: CommandDescriptor<PublishOptions> = createCommandDescriptor({
  name: 'publish',
  
  buildServiceConfig: (options, serviceInfo) => ({
    ...serviceInfo.config,
    platform: serviceInfo.platform,
    environment: options.environment,
    tag: options.tag,
    registry: options.registry,
    semiontRepo: options.semiontRepo,
    noCache: options.noCache,
  }),
  
  extractHandlerOptions: (options) => ({
    tag: options.tag,
    registry: options.registry,
    semiontRepo: options.semiontRepo,
    noCache: options.noCache,
    verbose: options.verbose,
    quiet: options.quiet,
    dryRun: options.dryRun,
  }),
  
  buildResult: (handlerResult: HandlerResult, service: Service, platform: PlatformStrategy, serviceType: string): CommandResult => {
    // Type guard for publish-specific results
    const publishResult = handlerResult as any; // PublishHandlerResult
    
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
      version: publishResult.version || publishResult.artifacts?.imageTag,
      artifacts: publishResult.artifacts,
      rollback: publishResult.rollback,
      registry: publishResult.registry,
      resources: publishResult.resources,
    });
  },
  
  validateOptions: (options) => {
    // Environment validation is handled by UnifiedExecutor
    if (options.tag && !/^[\w.-]+$/.test(options.tag)) {
      throw new Error('Tag must contain only alphanumeric characters, dots, underscores, and hyphens');
    }
  },
  
  continueOnError: true,  // Continue publishing all services even if one fails
  supportsAll: true,
});

// =====================================================================
// EXECUTOR INSTANCE
// =====================================================================

const publishExecutor = new UnifiedExecutor(publishDescriptor);

// =====================================================================
// COMMAND EXPORT
// =====================================================================

/**
 * Main publish command function
 */
export async function publish(
  serviceDeployments: ServicePlatformInfo[],
  options: PublishOptions
) {
  return publishExecutor.execute(serviceDeployments, options);
}

// PublishResult type alias removed - use CommandResult directly

// =====================================================================
// COMMAND DEFINITION (for CLI)
// =====================================================================

export const publishCommand = new CommandBuilder()
  .name('publish')
  .description('Publish services to their configured registries')
  .examples(
    'semiont publish --service frontend --tag v1.2.3',
    'semiont publish --service backend --no-cache',
    'semiont publish --all --registry my-registry.com'
  )
  .schema(PublishOptionsSchema)
  .handler(publish)
  .build();