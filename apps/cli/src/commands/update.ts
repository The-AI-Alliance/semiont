/**
 * Update Command - New Service-based implementation
 */

import { z } from 'zod';
import { printError, printSuccess, printInfo, printWarning } from '../lib/cli-logger.js';
import { type ServicePlatformInfo } from '../lib/platform-resolver.js';
import { CommandResults } from '../lib/command-results.js';
import { CommandBuilder } from '../lib/command-definition.js';
import { BaseOptionsSchema, withBaseArgs } from '../lib/base-options-schema.js';

// Import new service architecture
import { ServiceFactory } from '../services/service-factory.js';
import { Config, ServiceName, Platform, UpdateResult } from '../services/types.js';
import { parseEnvironment } from '../lib/environment-validator.js';

const PROJECT_ROOT = process.env.SEMIONT_ROOT || process.cwd();

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const UpdateOptionsSchema = BaseOptionsSchema.extend({
  service: z.string().optional(),
  all: z.boolean().default(false),
});

type UpdateOptions = z.output<typeof UpdateOptionsSchema>;

// =====================================================================
// COMMAND HANDLER
// =====================================================================

async function updateHandler(
  services: ServicePlatformInfo[],
  options: UpdateOptions
): Promise<CommandResults<UpdateResult>> {
  const serviceResults: UpdateResult[] = [];
  
  // Create config for services
  const config: Config = {
    projectRoot: PROJECT_ROOT,
    environment: parseEnvironment(options.environment),
    verbose: options.verbose,
    quiet: options.quiet,
    dryRun: options.dryRun,
  };
  
  for (const serviceInfo of services) {
    
    try {
      // Create service instance
      const service = ServiceFactory.create(
        serviceInfo.name as ServiceName,
        serviceInfo.platform as Platform,
        config,
        {
          platform: serviceInfo.platform as Platform
        } // Service config would come from project config
      );
      
      // Update the service
      const result = await service.update();
      
      // Record result directly - no conversion needed!
      serviceResults.push(result);
      
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
      serviceResults.push({
        entity: serviceInfo.name as ServiceName,
        platform: serviceInfo.platform as Platform,
        success: false,
        updateTime: new Date(),
        strategy: 'none',
        error: error instanceof Error ? error.message : String(error)
      });
      
      if (!options.quiet) {
        printError(`Failed to update ${serviceInfo.name}: ${error}`);
      }
    }
  }
  
  // Summary for multiple services
  if (!options.quiet && services.length > 1) {
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
  
  // Return results directly - no conversion needed!
  const startTime = Date.now();
  return {
    command: 'update',
    environment: options.environment || 'default',
    timestamp: new Date(),
    duration: Date.now() - startTime,
    results: serviceResults,  // Rich types preserved!
    summary: {
      total: services.length,
      succeeded: serviceResults.filter(r => r.success).length,
      failed: serviceResults.filter(r => !r.success).length,
      warnings: 0
    },
    executionContext: {
      user: process.env.USER || 'unknown',
      workingDirectory: process.cwd(),
      dryRun: options.dryRun || false
    }
  } as CommandResults<UpdateResult>;
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const updateNewCommand = new CommandBuilder()
  .name('update-new')
  .description('Update services to latest version using new service architecture')
  .schema(UpdateOptionsSchema)
  .requiresServices(true)
  .args(withBaseArgs({
    '--service': { type: 'string', description: 'Service name or "all" for all services' },
  }))
  .handler(updateHandler)
  .build();