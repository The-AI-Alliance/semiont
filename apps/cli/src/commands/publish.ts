/**
 * Publish Command
 * 
 * Publishes service artifacts to registries or deployment targets.
 * This command handles building, packaging, and pushing service code
 * and configurations to production environments.
 * 
 * Workflow:
 * 1. Builds service artifacts (containers, packages, bundles)
 * 2. Runs pre-publish validation and tests
 * 3. Tags artifacts with version information
 * 4. Pushes to platform-specific registries
 * 5. Updates deployment manifests and configurations
 * 
 * Options:
 * - --all: Publish all services
 * - --tag: Version tag for the publication
 * - --registry: Target registry for artifacts
 * - --skip-tests: Skip test execution before publishing
 * - --force: Overwrite existing artifacts
 * 
 * Platform Behavior:
 * - Process: Creates deployment packages, updates scripts
 * - Container: Builds and pushes Docker images to registry
 * - AWS: Pushes to ECR, updates Lambda functions, CloudFormation
 * - External: Updates external service configurations
 * - Mock: Simulates publication process for testing
 */

import { z } from 'zod';
import { printError, printSuccess, printInfo, printWarning } from '../lib/cli-logger.js';
import { type ServicePlatformInfo } from '../platforms/platform-resolver.js';
import { CommandResults } from '../commands/command-results.js';
import { CommandBuilder } from '../commands/command-definition.js';
import { BaseOptionsSchema, withBaseArgs } from '../commands/base-options-schema.js';

// Import new service architecture
import { ServiceFactory } from '../services/service-factory.js';
import { ServiceName } from '../services/service-interface.js';
import { Platform } from '../platforms/platform-resolver.js';
import { PlatformResources } from '../platforms/platform-resources.js';
import { Config, ServiceConfig } from '../lib/cli-config.js';
import { parseEnvironment } from '../lib/environment-validator.js';

const PROJECT_ROOT = process.env.SEMIONT_ROOT || process.cwd();

// =====================================================================
// RESULT TYPE DEFINITIONS
// =====================================================================

/**
 * Result of a publish operation
 */
export interface PublishResult {
  entity: ServiceName | string;
  platform: Platform;
  success: boolean;
  publishTime: Date;
  artifacts?: {
    // Published artifacts
    imageTag?: string;
    imageUrl?: string;
    packageName?: string;
    packageVersion?: string;
    bundleUrl?: string;
    staticSiteUrl?: string;
    // Registry/repository info
    registry?: string;
    repository?: string;
    branch?: string;
    commitSha?: string;
  };
  version?: {
    previous?: string;
    current?: string;
    tag?: string;
  };
  destinations?: {
    registry?: string;
    bucket?: string;
    cdn?: string;
    repository?: string;
  };
  rollback?: {
    supported: boolean;
    command?: string;
    artifactId?: string;
  };
  resources?: PlatformResources;
  error?: string;
  metadata?: Record<string, any>;
}

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const PublishOptionsSchema = BaseOptionsSchema.extend({
  service: z.string().optional(),
  all: z.boolean().default(false),
  tag: z.string().optional(), // Custom version tag
  registry: z.string().optional(), // Override default registry
});

type PublishOptions = z.output<typeof PublishOptionsSchema>;

// =====================================================================
// COMMAND HANDLER
// =====================================================================

async function publishHandler(
  services: ServicePlatformInfo[],
  options: PublishOptions
): Promise<CommandResults<PublishResult>> {
  const startTime = Date.now();
  const serviceResults: PublishResult[] = [];
  
  // Create config for services
  const config: Config = {
    projectRoot: PROJECT_ROOT,
    environment: parseEnvironment(options.environment),
    verbose: options.verbose,
    quiet: options.quiet,
    dryRun: options.dryRun,
  };
  
  // Let platforms handle publish ordering
  const sortedServices = sortServicesByPublishOrder(services);
  
  // Track publishing results
  const publishResults = new Map<string, PublishResult>();
  const rollbackCommands: string[] = [];
  
  for (const serviceInfo of sortedServices) {
    
    try {
      // Create service instance
      const service = ServiceFactory.create(
        serviceInfo.name as ServiceName,
        serviceInfo.platform,
        config,
        { 
          platform: serviceInfo.platform,
          tag: options.tag,
          registry: options.registry
        } as ServiceConfig
      );
      
      // Get the platform strategy
      const { PlatformFactory } = await import('../platforms/index.js');
      const platform = PlatformFactory.getPlatform(serviceInfo.platform);
      
      // Platform handles the publish command
      const result = await platform.publish(service);
      publishResults.set(serviceInfo.name, result);
      
      // Track result directly - no conversion needed!
      serviceResults.push(result);
      
      // Collect rollback command if available
      if (result.rollback?.supported && result.rollback.command) {
        rollbackCommands.unshift(result.rollback.command); // Reverse order for rollback
      }
      
      // Display result
      if (!options.quiet) {
        if (result.success) {
          printSuccess(`🚀 ${serviceInfo.name} (${serviceInfo.platform}) published`);
          
          // Show version info
          if (result.version?.current) {
            console.log(`   📦 Version: ${result.version.current}`);
          }
          
          // Show artifacts
          if (result.artifacts) {
            if (result.artifacts.imageUrl) {
              console.log(`   🐳 Image: ${result.artifacts.imageUrl}`);
            }
            if (result.artifacts.staticSiteUrl) {
              console.log(`   🌐 Site: ${result.artifacts.staticSiteUrl}`);
            }
            if (result.artifacts.packageName) {
              console.log(`   📦 Package: ${result.artifacts.packageName}@${result.artifacts.packageVersion}`);
            }
            if (result.artifacts.bundleUrl) {
              console.log(`   📄 Bundle: ${result.artifacts.bundleUrl}`);
            }
          }
          
          // Show destinations
          if (result.destinations) {
            if (result.destinations.registry) {
              console.log(`   📂 Registry: ${result.destinations.registry}`);
            }
            if (result.destinations.bucket) {
              console.log(`   🪣 Bucket: ${result.destinations.bucket}`);
            }
            if (result.destinations.cdn) {
              console.log(`   ⚡ CDN: ${result.destinations.cdn}`);
            }
          }
          
          // Show rollback info
          if (result.rollback?.supported) {
            const rollbackEmoji = result.rollback.supported ? '↩️' : '❌';
            console.log(`   ${rollbackEmoji} Rollback: ${result.rollback.supported ? 'Available' : 'Not supported'}`);
          }
          
          // Show git info
          if (result.artifacts?.commitSha) {
            console.log(`   🔗 Commit: ${result.artifacts.commitSha} (${result.artifacts.branch || 'unknown branch'})`);
          }
          
          // Show metadata in verbose mode
          if (options.verbose && result.metadata) {
            console.log('   📝 Details:', JSON.stringify(result.metadata, null, 2));
          }
        } else {
          printError(`❌ Failed to publish ${serviceInfo.name}: ${result.error}`);
        }
      }
      
    } catch (error) {
      serviceResults.push({
        entity: serviceInfo.name as ServiceName,
        platform: serviceInfo.platform,
        success: false,
        publishTime: new Date(),
        error: error instanceof Error ? error.message : String(error)
      });
      
      if (!options.quiet) {
        printError(`Failed to publish ${serviceInfo.name}: ${error}`);
      }
    }
  }
  
  // Summary for multiple services
  if (!options.quiet && services.length > 1) {
    console.log('\n📊 Publishing Summary:');
    
    const successful = serviceResults.filter((r: any) => r.success).length;
    const failed = serviceResults.filter((r: any) => !r.success).length;
    
    console.log(`   ✅ Successful: ${successful}`);
    if (failed > 0) console.log(`   ❌ Failed: ${failed}`);
    
    // Platform breakdown
    const platforms = serviceResults.reduce((acc: any, r: any) => {
      if (r.success) {
        acc[r.deployment] = (acc[r.deployment] || 0) + 1;
      }
      return acc;
    }, {} as Record<string, number>);
    
    console.log('\n🖥️  Platform breakdown:');
    Object.entries(platforms).forEach(([platform, count]) => {
      const emoji = {
        'process': '⚡',
        'container': '🐳',
        'aws': '☁️',
        'external': '🔗'
      }[platform] || '❓';
      console.log(`   ${emoji} ${platform}: ${count} published`);
    });
    
    // Rollback instructions
    if (rollbackCommands.length > 0) {
      console.log('\n↩️  Rollback commands (run in reverse order):');
      rollbackCommands.forEach((cmd, index) => {
        console.log(`   ${index + 1}. ${cmd}`);
      });
    }
    
    if (successful === services.length) {
      printSuccess('\n🎉 All services published successfully!');
    } else if (failed > 0) {
      printWarning(`\n⚠️  ${failed} service(s) failed to publish.`);
    }
  }
  
  if (options.dryRun && !options.quiet) {
    printInfo('\n🔍 This was a dry run. No actual publishing was performed.');
  }
  
  // Return results directly - no conversion needed!
  return {
    command: 'publish',
    environment: options.environment || 'default',
    timestamp: new Date(),
    duration: Date.now() - startTime,
    results: serviceResults,  // Rich types preserved!
    summary: {
      total: services.length,
      succeeded: serviceResults.filter((r: any) => r.success).length,
      failed: serviceResults.filter((r: any) => !r.success).length,
      warnings: 0
    },
    executionContext: {
      user: process.env.USER || 'unknown',
      workingDirectory: process.cwd(),
      dryRun: options.dryRun || false
    }
  } as CommandResults<PublishResult>;
}

/**
 * Sort services for publishing
 * Platforms determine the actual ordering
 */
function sortServicesByPublishOrder(services: ServicePlatformInfo[]): ServicePlatformInfo[] {
  // Platforms handle publish ordering
  // Just return services in the order provided
  return services;
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const publishCommand = new CommandBuilder()
  .name('publish-new')
  .description('Publish and deploy service artifacts')
  .schema(PublishOptionsSchema)
  .requiresServices(true)
  .args(withBaseArgs({
    '--service': { type: 'string', description: 'Service name or "all" for all services' },
    '--tag': { type: 'string', description: 'Custom version tag' },
    '--registry': { type: 'string', description: 'Override default registry' },
  }))
  .handler(publishHandler)
  .build();