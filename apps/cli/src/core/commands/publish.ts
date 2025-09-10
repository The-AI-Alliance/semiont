/**
 * Publish Command - Unified Executor Implementation
 * 
 * Builds and publishes service artifacts to their respective registries (Docker Hub, ECR, npm, etc.)
 * using the MultiServiceExecutor architecture.
 * 
 * For containerized services (e.g., ECS):
 * - Builds the application/container
 * - Pushes the image to the registry with appropriate tags (mutable or immutable based on config)
 * - Creates a new task definition revision (for ECS) or equivalent metadata
 * - Does NOT deploy or update running services - that's the job of the 'update' command
 * 
 * The publish command prepares artifacts for deployment but does not perform the deployment itself.
 * Use 'semiont update' after publishing to deploy the new version to running services.
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
  
  buildResult: (handlerResult: HandlerResult, service: Service, platform: Platform, serviceType: string): CommandResult => {
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
    // Environment validation is handled by MultiServiceExecutor
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

const publishExecutor = new MultiServiceExecutor(publishDescriptor);

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
  .args({
    args: {
      '--service': {
        type: 'string',
        description: 'Service to publish (or "all" for all services)',
      },
      '--all': {
        type: 'boolean',
        description: 'Publish all services',
        default: false,
      },
      '--tag': {
        type: 'string',
        description: 'Custom version tag',
      },
      '--registry': {
        type: 'string',
        description: 'Override default registry',
      },
      '--semiont-repo': {
        type: 'string',
        description: 'Path to Semiont repository for builds',
      },
      '--no-cache': {
        type: 'boolean',
        description: 'Skip Docker cache',
        default: false,
      },
    },
    aliases: {
      '-s': '--service',
    },
  })
  .schema(PublishOptionsSchema)
  .handler(publish)
  .build();