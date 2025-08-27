/**
 * Publish Command - Service-based implementation
 */

import { z } from 'zod';
import { printError, printSuccess, printInfo, printWarning } from '../lib/cli-logger.js';
import { type ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import { CommandResults } from '../lib/command-results.js';
import { CommandBuilder } from '../lib/command-definition.js';
import { BaseOptionsSchema } from '../lib/base-options-schema.js';

// Import new service architecture
import { ServiceFactory } from '../services/service-factory.js';
import { Config, ServiceName, DeploymentType, PublishResult, ServiceConfig } from '../services/types.js';
import { parseEnvironment } from '../lib/environment-validator.js';

const PROJECT_ROOT = process.env.SEMIONT_ROOT || process.cwd();

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
  services: ServiceDeploymentInfo[],
  options: PublishOptions
): Promise<CommandResults> {
  const startTime = Date.now();
  interface ServicePublishResult {
    service: string;
    success: boolean;
    duration: number;
    deployment: string;
    registryUrl?: string;
    imageTag?: string;
    size?: number;
    layers?: number;
    platform?: string;
    architecture?: string;
    baseImage?: string;
    error?: string;
    buildTime?: number;
    pushTime?: number;
    scanTime?: number;
    cacheUsed?: boolean;
    cacheRatio?: number;
    multiArch?: boolean;
    architectures?: string[];
    vulnerabilities?: any;
    compliance?: any;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    signature?: any;
    metadata?: Record<string, any>;
    artifacts?: any;
    version?: string;
    destinations?: any;
    rollback?: any;
  }
  const serviceResults: ServicePublishResult[] = [];
  
  // Create config for services
  const config: Config = {
    projectRoot: PROJECT_ROOT,
    environment: parseEnvironment(options.environment),
    verbose: options.verbose,
    quiet: options.quiet,
    dryRun: options.dryRun,
  };
  
  // Sort services by publish order (backend first for dependency reasons)
  const sortedServices = sortServicesByPublishOrder(services);
  
  // Track publishing results
  const publishResults = new Map<string, PublishResult>();
  const rollbackCommands: string[] = [];
  
  for (const serviceInfo of sortedServices) {
    const startTime = Date.now();
    
    try {
      // Create service instance
      const service = ServiceFactory.create(
        serviceInfo.name as ServiceName,
        serviceInfo.deploymentType as DeploymentType,
        config,
        { 
          deploymentType: serviceInfo.deploymentType as DeploymentType,
          tag: options.tag,
          registry: options.registry
        } as ServiceConfig
      );
      
      // Publish the service
      const result = await service.publish();
      publishResults.set(serviceInfo.name, result);
      
      // Track in serviceResults for CommandResults
      serviceResults.push({
        service: serviceInfo.name,
        success: result.success,
        duration: Date.now() - startTime,
        deployment: serviceInfo.deploymentType,
        artifacts: result.artifacts,
        version: typeof result.version === 'object' ? JSON.stringify(result.version) : result.version,
        destinations: result.destinations,
        rollback: result.rollback,
        metadata: result.metadata,
        error: result.error
      });
      
      // Collect rollback command if available
      if (result.rollback?.supported && result.rollback.command) {
        rollbackCommands.unshift(result.rollback.command); // Reverse order for rollback
      }
      
      // Record result
      serviceResults.push({
        service: serviceInfo.name,
        success: result.success,
        duration: Date.now() - startTime,
        deployment: serviceInfo.deploymentType,
        artifacts: result.artifacts,
        version: typeof result.version === 'object' ? JSON.stringify(result.version) : result.version,
        destinations: result.destinations,
        rollback: result.rollback,
        metadata: result.metadata,
        error: result.error
      });
      
      // Display result
      if (!options.quiet) {
        if (result.success) {
          printSuccess(`🚀 ${serviceInfo.name} (${serviceInfo.deploymentType}) published`);
          
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
        service: serviceInfo.name,
        success: false,
        duration: Date.now() - startTime,
        deployment: serviceInfo.deploymentType,
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
  
  // Convert service results to CommandResults format
  const formattedResults = serviceResults.map(r => ({
    command: 'publish',
    service: r.service,
    deploymentType: r.deployment,
    environment: options.environment || 'default',
    timestamp: new Date(),
    success: r.success,
    duration: r.duration,
    // resourceId is optional for publish
    status: r.success ? 'published' : 'failed',
    metadata: {
      ...r.metadata,
      artifacts: r.artifacts,
      version: r.version,
      destinations: r.destinations,
      rollback: r.rollback
    },
    error: r.error
  }));
  
  return {
    command: 'publish',
    environment: options.environment || 'default',
    timestamp: new Date(),
    duration: Date.now() - startTime,
    services: formattedResults,
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
  } as CommandResults;
}

/**
 * Sort services by publish order
 * Generally: backend first (others depend on it), then frontend, then utilities
 */
function sortServicesByPublishOrder(services: ServiceDeploymentInfo[]): ServiceDeploymentInfo[] {
  const publishOrder = ['database', 'backend', 'mcp', 'frontend', 'filesystem', 'agent'];
  
  return services.sort((a, b) => {
    const aIndex = publishOrder.indexOf(a.name);
    const bIndex = publishOrder.indexOf(b.name);
    
    // If not in publish order, put at end
    if (aIndex === -1) return 1;
    if (bIndex === -1) return -1;
    
    return aIndex - bIndex;
  });
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const publishNewCommand = new CommandBuilder<PublishOptions>()
  .name('publish-new')
  .description('Publish and deploy service artifacts')
  .schema(PublishOptionsSchema)
  .requiresServices(true)
  .handler(publishHandler)
  .build();