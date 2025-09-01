/**
 * Provision Command
 * 
 * Provisions infrastructure resources required by services before they can start.
 * This command handles pre-deployment setup, resource allocation, and environment
 * preparation across different platforms.
 * 
 * Workflow:
 * 1. Analyzes service requirements (compute, network, storage)
 * 2. Checks for existing resources to avoid duplication
 * 3. Provisions platform-specific infrastructure
 * 4. Configures networking, security, and access controls
 * 5. Validates provisioned resources are ready
 * 
 * Options:
 * - --all: Provision resources for all services
 * - --plan: Show what would be provisioned without doing it
 * - --parallel: Provision multiple services simultaneously
 * - --wait: Wait for resources to be fully ready
 * 
 * Platform Behavior:
 * - Process: Creates directories, checks ports, sets permissions
 * - Container: Pulls images, creates networks, prepares volumes
 * - AWS: Creates ECS clusters, VPCs, load balancers, databases
 * - External: Validates external service availability
 * - Mock: Simulates resource provisioning for testing
 */

import { z } from 'zod';
import { printError, printSuccess, printInfo, printWarning } from '../io/cli-logger.js';
import { type ServicePlatformInfo } from '../platform-resolver.js';
import { CommandResults } from '../command-results.js';
import { CommandBuilder } from '../command-definition.js';
import { BaseOptionsSchema, withBaseArgs } from '../base-options-schema.js';

// Import new service architecture
import { ServiceFactory } from '../../services/service-factory.js';
import { ServiceName } from '../service-discovery.js';
import { Platform } from '../platform-resolver.js';
import { PlatformResources } from '../../platforms/platform-resources.js';
import { Config } from '../cli-config.js';
import { parseEnvironment } from '../environment-validator.js';
import { provisionCdkStack } from './provision-cdk.js';

const PROJECT_ROOT = process.env.SEMIONT_ROOT || process.cwd();

// =====================================================================
// RESULT TYPE DEFINITIONS
// =====================================================================

/**
 * Result of a provision operation
 */
export interface ProvisionResult {
  entity: ServiceName | string;
  platform: Platform;
  success: boolean;
  provisionTime: Date;
  dependencies?: string[]; // Other services this depends on
  cost?: {
    estimatedMonthly?: number;
    currency?: string;
  };
  resources?: PlatformResources;
  error?: string;
  metadata?: Record<string, any>;
}

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const ProvisionOptionsSchema = BaseOptionsSchema.extend({
  service: z.string().optional(),
  stack: z.string().optional(), // CDK stack to provision (data, app, infra, or all)
  all: z.boolean().default(false),
  force: z.boolean().default(false), // Force re-provisioning
});

type ProvisionOptions = z.output<typeof ProvisionOptionsSchema>;

// =====================================================================
// COMMAND HANDLER
// =====================================================================

async function performProvision(
  service: any,
  platform: any
): Promise<ProvisionResult> {
  const serviceType = platform.determineServiceType(service);
  const { HandlerRegistry } = await import('../handlers/registry.js');
  const registry = HandlerRegistry.getInstance();
  
  const descriptor = registry.getDescriptor(
    platform.getPlatformName(),
    `provision-${serviceType}`
  );
  
  if (!descriptor) {
    // No handler found, return error result
    return {
      entity: service.name,
      platform: platform.getPlatformName() as Platform,
      success: false,
      provisionTime: new Date(),
      dependencies: [],
      error: `No provision handler registered for service type: ${serviceType}`,
      metadata: {
        serviceType
      }
    };
  }

  const { HandlerContextBuilder } = await import('../handlers/context-builder.js');
  
  const contextExtensions = await platform.buildHandlerContextExtensions(
    service, 
    descriptor.requiresDiscovery || false
  );
  
  const context = HandlerContextBuilder.extend(
    HandlerContextBuilder.buildBaseContext(service, platform.getPlatformName()),
    contextExtensions
  );
  
  const result = await descriptor.handler(context) as any; // ProvisionHandlerResult
  
  return {
    entity: service.name,
    platform: platform.getPlatformName() as Platform,
    success: result.success,
    provisionTime: new Date(),
    dependencies: result.dependencies || [],
    resources: result.resources,
    cost: result.cost,
    error: result.error,
    metadata: {
      ...result.metadata,
      serviceType
    }
  };
}

async function provisionServiceImpl(
  serviceInfo: ServicePlatformInfo, 
  config: Config,
  options: any
): Promise<ProvisionResult> {
  // Get the platform strategy
  const { PlatformFactory } = await import('../../platforms/index.js');
  const platform = PlatformFactory.getPlatform(serviceInfo.platform);
  
  // Create service instance to act as ServiceContext
  const service = ServiceFactory.create(
    serviceInfo.name as ServiceName,
    serviceInfo.platform,
    config,
    {
      platform: serviceInfo.platform,
      environment: options.environment
    } // Service config would come from project config
  );
  
  // Check if already provisioned (unless force)
  if (!options.force) {
    // Could implement provisioning state check here
  }
  
  // Use handler-based approach
  return performProvision(service, platform);
}

async function provisionHandler(
  options: ProvisionOptions
): Promise<CommandResults<ProvisionResult>> {
  const serviceResults: ProvisionResult[] = [];
  const commandStartTime = Date.now();
  
  // If --stack is specified, handle CDK stack provisioning
  if (options.stack) {
    return await provisionCdkStack({
      stack: options.stack,
      environment: options.environment || 'development',
      force: options.force,
      destroy: false, // Add destroy option if needed
      dryRun: options.dryRun,
      verbose: options.verbose,
      quiet: options.quiet,
      requireApproval: false // Could be added to options schema
    });
  }
  
  // When not using --stack, we need to resolve services
  // Import service resolution logic
  const { resolveServiceSelector } = await import('../command-service-matcher.js');
  const { resolveServiceDeployments } = await import('../platform-resolver.js');
  
  // Resolve services based on --service flag or default to 'all'
  const serviceSelector = options.service || 'all';
  const resolvedServiceNames = await resolveServiceSelector(
    serviceSelector, 
    'provision', // Use string literal instead of enum
    options.environment || 'development'
  );
  const services = resolveServiceDeployments(resolvedServiceNames, options.environment || 'development');
  
  // Create config for services
  const config: Config = {
    projectRoot: PROJECT_ROOT,
    environment: parseEnvironment(options.environment),
    verbose: options.verbose,
    quiet: options.quiet,
    dryRun: options.dryRun,
  };
  
  // Let platforms handle dependency ordering
  const sortedServices = sortServicesByDependencies(services);
  
  // Track provisioning results for dependency resolution
  const provisionResults = new Map<string, ProvisionResult>();
  let totalCost = 0;
  
  for (const serviceInfo of sortedServices) {
    
    try {
      const result = await provisionServiceImpl(serviceInfo, config, options);
      provisionResults.set(serviceInfo.name, result);
      
      // Track total cost
      if (result.cost?.estimatedMonthly) {
        totalCost += result.cost.estimatedMonthly;
      }
      
      // Record result directly - no conversion needed!
      serviceResults.push(result);
      
      // Display result
      if (!options.quiet) {
        if (result.success) {
          printSuccess(`✅ ${serviceInfo.name} (${serviceInfo.platform}) provisioned`);
          
          // Show key resources based on platform
          if (result.resources) {
            if (result.resources.platform === 'aws') {
              const awsData = result.resources.data;
              if (awsData.clusterId) {
                console.log(`   🖥️  Cluster: ${awsData.clusterId}`);
              }
              if (awsData.instanceId) {
                console.log(`   🗄️  Instance: ${awsData.instanceId}`);
              }
              if (awsData.bucketName) {
                console.log(`   🪣  Bucket: ${awsData.bucketName}`);
              }
              if (awsData.volumeId) {
                console.log(`   💾 Volume: ${awsData.volumeId}`);
              }
              if (awsData.networkId) {
                console.log(`   🌐 Network: ${awsData.networkId}`);
              }
            }
          }
          
          // Show cost
          if (result.cost?.estimatedMonthly) {
            console.log(`   💰 Monthly cost: $${result.cost.estimatedMonthly} ${result.cost.currency}`);
          }
          
          // Show dependencies
          if (result.dependencies && result.dependencies.length > 0) {
            console.log(`   🔗 Depends on: ${result.dependencies.join(', ')}`);
          }
          
          // Show metadata in verbose mode
          if (options.verbose && result.metadata) {
            console.log('   📝 Details:', JSON.stringify(result.metadata, null, 2));
          }
        } else {
          printError(`❌ Failed to provision ${serviceInfo.name}: ${result.error}`);
        }
      }
      
    } catch (error) {
      serviceResults.push({
        entity: serviceInfo.name as ServiceName,
        platform: serviceInfo.platform,
        success: false,
        provisionTime: new Date(),
        error: error instanceof Error ? error.message : String(error)
      });
      
      if (!options.quiet) {
        printError(`Failed to provision ${serviceInfo.name}: ${error}`);
      }
    }
  }
  
  // Summary for multiple services
  if (!options.quiet && services.length > 1) {
    console.log('\n📊 Provisioning Summary:');
    
    const successful = serviceResults.filter(r => r.success).length;
    const failed = serviceResults.filter(r => !r.success).length;
    
    console.log(`   ✅ Successful: ${successful}`);
    if (failed > 0) console.log(`   ❌ Failed: ${failed}`);
    
    // Total cost estimate
    if (totalCost > 0) {
      console.log(`\n💰 Total estimated monthly cost: $${totalCost.toFixed(2)} USD`);
    }
    
    // Platform breakdown
    const platforms = serviceResults.reduce((acc, r) => {
      acc[r.platform] = (acc[r.platform] || 0) + 1;
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
      console.log(`   ${emoji} ${platform}: ${count}`);
    });
    
    if (successful === services.length) {
      printSuccess('\n🎉 All services provisioned successfully!');
    } else if (failed > 0) {
      printWarning(`\n⚠️  ${failed} service(s) failed to provision.`);
    }
  }
  
  if (options.dryRun && !options.quiet) {
    printInfo('\n🔍 This was a dry run. No actual provisioning was performed.');
  }
  
  // Return results directly - no conversion needed!
  return {
    command: 'provision',
    environment: options.environment || 'unknown',
    timestamp: new Date(),
    duration: Date.now() - commandStartTime,
    results: serviceResults,  // Rich types preserved!
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
  } as CommandResults<ProvisionResult>;
}

/**
 * Sort services by dependencies
 * Platforms determine the actual ordering
 */
function sortServicesByDependencies(services: ServicePlatformInfo[]): ServicePlatformInfo[] {
  // Platforms handle dependency resolution
  // Just return services in the order provided
  return services;
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const provisionCommand = new CommandBuilder()
  .name('provision-new')
  .description('Provision infrastructure and resources for services')
  .schema(ProvisionOptionsSchema)
  .requiresEnvironment(true)
  .args(withBaseArgs({
    '--service': { type: 'string', description: 'Service name or "all" for all services' },
    '--stack': { type: 'string', description: 'CDK stack to provision (data, app, infra, or all)' },
    '--force': { type: 'boolean', description: 'Force re-provisioning' },
  }, {
    '-f': '--force',
    '-s': '--stack',
  }))
  .setupHandler(provisionHandler) // Use setupHandler since we handle service resolution internally
  .build();