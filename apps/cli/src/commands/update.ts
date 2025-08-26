/**
 * Update Command - New Service-based implementation
 */

import { z } from 'zod';
import { printError, printSuccess, printInfo, printWarning } from '../lib/cli-logger.js';
import { type ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import { CommandResults } from '../lib/command-results-class.js';
import { CommandBuilder } from '../lib/command-definition.js';
import type { BaseCommandOptions } from '../lib/base-command-options.js';

// Import new service architecture
import { ServiceFactory } from '../services/service-factory.js';
import { Config, ServiceName, DeploymentType } from '../services/types.js';

const PROJECT_ROOT = process.env.SEMIONT_ROOT || process.cwd();

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const UpdateOptionsSchema = z.object({
  environment: z.string().optional(),
  output: z.enum(['summary', 'table', 'json', 'yaml']).default('summary'),
  quiet: z.boolean().default(false),
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  service: z.string().optional(),
  all: z.boolean().default(false),
});

type UpdateOptions = z.infer<typeof UpdateOptionsSchema> & BaseCommandOptions;

// =====================================================================
// COMMAND HANDLER
// =====================================================================

async function updateHandler(
  options: UpdateOptions,
  services: ServiceDeploymentInfo[]
): Promise<CommandResults> {
  const results = new CommandResults();
  
  // Create config for services
  const config: Config = {
    projectRoot: PROJECT_ROOT,
    environment: options.environment as any || 'dev',
    verbose: options.verbose,
    quiet: options.quiet,
    dryRun: options.dryRun,
  };
  
  for (const serviceInfo of services) {
    const startTime = Date.now();
    
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
      
      // Update the service
      const result = await service.update();
      
      // Record result
      results.addResult(serviceInfo.name, {
        success: result.success,
        duration: Date.now() - startTime,
        deployment: serviceInfo.deploymentType,
        strategy: result.strategy,
        previousVersion: result.previousVersion,
        newVersion: result.newVersion,
        downtime: result.downtime,
        metadata: result.metadata,
        error: result.error
      });
      
      // Display result
      if (!options.quiet) {
        if (result.success) {
          const strategyEmoji = {
            'restart': '🔄',
            'recreate': '♻️',
            'rolling': '🌊',
            'blue-green': '🔵🟢',
            'none': '⏸️'
          }[result.strategy] || '❓';
          
          printSuccess(`${strategyEmoji} ${serviceInfo.name} updated (${result.strategy} strategy)`);
          
          // Show version info if available
          if (result.previousVersion || result.newVersion) {
            console.log(`   Version: ${result.previousVersion || '?'} → ${result.newVersion || 'latest'}`);
          }
          
          // Show downtime if measured
          if (result.downtime !== undefined) {
            const seconds = (result.downtime / 1000).toFixed(1);
            console.log(`   Downtime: ${seconds}s`);
          }
          
          // Show metadata
          if (result.metadata) {
            if (result.metadata.message) {
              console.log(`   ℹ️  ${result.metadata.message}`);
            }
            if (options.verbose) {
              const { message, ...otherMetadata } = result.metadata;
              if (Object.keys(otherMetadata).length > 0) {
                console.log('   Metadata:', JSON.stringify(otherMetadata, null, 2));
              }
            }
          }
        } else {
          printError(`❌ Failed to update ${serviceInfo.name}: ${result.error}`);
        }
      }
      
    } catch (error) {
      results.addResult(serviceInfo.name, {
        success: false,
        duration: Date.now() - startTime,
        deployment: serviceInfo.deploymentType,
        error: error instanceof Error ? error.message : String(error)
      });
      
      if (!options.quiet) {
        printError(`Failed to update ${serviceInfo.name}: ${error}`);
      }
    }
  }
  
  // Summary for multiple services
  if (!options.quiet && services.length > 1) {
    const serviceResults = results.getAllResults();
    console.log('\n📊 Update Summary:');
    
    const successful = serviceResults.filter((r: any) => r.data.success).length;
    const failed = serviceResults.filter((r: any) => !r.data.success).length;
    
    // Count by strategy
    const strategies = serviceResults.reduce((acc: any, r: any) => {
      if (r.data.success && r.data.strategy) {
        acc[r.data.strategy] = (acc[r.data.strategy] || 0) + 1;
      }
      return acc;
    }, {} as Record<string, number>);
    
    console.log(`   Successful: ${successful}`);
    if (failed > 0) console.log(`   Failed: ${failed}`);
    
    if (Object.keys(strategies).length > 0) {
      console.log('\n   Strategies used:');
      Object.entries(strategies).forEach(([strategy, count]) => {
        const emoji = {
          'restart': '🔄',
          'recreate': '♻️',
          'rolling': '🌊',
          'blue-green': '🔵🟢',
          'none': '⏸️'
        }[strategy] || '❓';
        console.log(`     ${emoji} ${strategy}: ${count}`);
      });
    }
    
    // Calculate total downtime
    const totalDowntime = serviceResults
      .filter((r: any) => r.data.downtime !== undefined)
      .reduce((sum: number, r: any) => sum + (r.data.downtime || 0), 0);
    
    if (totalDowntime > 0) {
      const seconds = (totalDowntime / 1000).toFixed(1);
      console.log(`\n   Total downtime: ${seconds}s`);
    }
    
    if (successful === services.length) {
      printSuccess('\n✨ All services updated successfully!');
    } else if (failed > 0) {
      printWarning(`\n⚠️  ${failed} service(s) failed to update.`);
    }
  }
  
  if (options.dryRun && !options.quiet) {
    printInfo('\n🔍 This was a dry run. No actual changes were made.');
  }
  
  return results;
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const updateNewCommand = new CommandBuilder('update-new')
  .description('Update services to latest version using new service architecture')
  .schema(UpdateOptionsSchema)
  .requiresServices(true)
  .handler(updateHandler)
  .build();