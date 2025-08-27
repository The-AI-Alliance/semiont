/**
 * Provision Command - Service-based implementation
 */

import { z } from 'zod';
import { printError, printSuccess, printInfo, printWarning } from '../lib/cli-logger.js';
import { type ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import { CommandResults } from '../lib/command-results.js';
import { CommandBuilder } from '../lib/command-definition.js';
import { BaseOptionsSchema } from '../lib/base-options-schema.js';

// Import new service architecture
import { ServiceFactory } from '../services/service-factory.js';
import { Config, ServiceName, DeploymentType, ProvisionResult } from '../services/types.js';
import { parseEnvironment } from '../lib/environment-validator.js';

const PROJECT_ROOT = process.env.SEMIONT_ROOT || process.cwd();

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const ProvisionOptionsSchema = BaseOptionsSchema.extend({
  service: z.string().optional(),
  all: z.boolean().default(false),
  force: z.boolean().default(false), // Force re-provisioning
});

type ProvisionOptions = z.output<typeof ProvisionOptionsSchema>;

// =====================================================================
// COMMAND HANDLER
// =====================================================================

async function provisionHandler(
  services: ServiceDeploymentInfo[],
  options: ProvisionOptions
): Promise<CommandResults<ProvisionResult>> {
  const serviceResults: ProvisionResult[] = [];
  const commandStartTime = Date.now();
  
  // Create config for services
  const config: Config = {
    projectRoot: PROJECT_ROOT,
    environment: parseEnvironment(options.environment),
    verbose: options.verbose,
    quiet: options.quiet,
    dryRun: options.dryRun,
  };
  
  // Sort services by dependency order (database first, etc.)
  const sortedServices = sortServicesByDependencies(services);
  
  // Track provisioning results for dependency resolution
  const provisionResults = new Map<string, ProvisionResult>();
  let totalCost = 0;
  
  for (const serviceInfo of sortedServices) {
    
    try {
      // Create service instance
      const service = ServiceFactory.create(
        serviceInfo.name as ServiceName,
        serviceInfo.deploymentType as DeploymentType,
        config,
        {
          deploymentType: serviceInfo.deploymentType as DeploymentType
        } // Service config would come from project config
      );
      
      // Check if already provisioned (unless force)
      if (!options.force) {
        // Could implement provisioning state check here
      }
      
      // Provision the service
      const result = await service.provision();
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
          printSuccess(`✅ ${serviceInfo.name} (${serviceInfo.deploymentType}) provisioned`);
          
          // Show key resources
          if (result.resources) {
            if (result.resources.clusterId) {
              console.log(`   🖥️  Cluster: ${result.resources.clusterId}`);
            }
            if (result.resources.instanceId) {
              console.log(`   🗄️  Instance: ${result.resources.instanceId}`);
            }
            if (result.resources.bucketName) {
              console.log(`   🪣  Bucket: ${result.resources.bucketName}`);
            }
            if (result.resources.volumeId) {
              console.log(`   💾 Volume: ${result.resources.volumeId}`);
            }
            if (result.resources.networkId) {
              console.log(`   🌐 Network: ${result.resources.networkId}`);
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
        service: serviceInfo.name as ServiceName,
        deployment: serviceInfo.deploymentType as DeploymentType,
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
      acc[r.deployment] = (acc[r.deployment] || 0) + 1;
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
    services: serviceResults,  // Rich types preserved!
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
 * Sort services by dependency order
 * Database first, then backend, then frontend, etc.
 */
function sortServicesByDependencies(services: ServiceDeploymentInfo[]): ServiceDeploymentInfo[] {
  const dependencyOrder = ['filesystem', 'database', 'backend', 'frontend', 'mcp', 'agent'];
  
  return services.sort((a, b) => {
    const aIndex = dependencyOrder.indexOf(a.name);
    const bIndex = dependencyOrder.indexOf(b.name);
    
    // If not in dependency order, put at end
    if (aIndex === -1) return 1;
    if (bIndex === -1) return -1;
    
    return aIndex - bIndex;
  });
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const provisionNewCommand = new CommandBuilder()
  .name('provision-new')
  .description('Provision infrastructure and resources for services')
  .schema(ProvisionOptionsSchema)
  .requiresServices(true)
  .handler(provisionHandler)
  .build();