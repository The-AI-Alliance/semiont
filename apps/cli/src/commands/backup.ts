/**
 * Backup Command - Service-based implementation
 */

import { z } from 'zod';
import { printError, printSuccess, printInfo, printWarning } from '../lib/cli-logger.js';
import { type ServicePlatformInfo } from '../lib/platform-resolver.js';
import { CommandResults } from '../lib/command-results.js';
import { CommandBuilder } from '../lib/command-definition.js';
import { BaseOptionsSchema } from '../lib/base-options-schema.js';

// Import new service architecture
import { ServiceFactory } from '../services/service-factory.js';
import { Config, ServiceName, Platform, BackupResult } from '../services/types.js';
import { parseEnvironment } from '../lib/environment-validator.js';

const PROJECT_ROOT = process.env.SEMIONT_ROOT || process.cwd();

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const BackupOptionsSchema = BaseOptionsSchema.extend({
  service: z.string().optional(),
  all: z.boolean().default(false),
  name: z.string().optional(), // Custom backup name
  outputPath: z.string().default('./backups'), // Where to store backups
  retention: z.string().optional(), // Custom retention policy
  encrypt: z.boolean().default(false), // Force encryption
  compress: z.boolean().default(true), // Use compression
});

type BackupOptions = z.output<typeof BackupOptionsSchema>;

// =====================================================================
// COMMAND HANDLER
// =====================================================================

async function backupHandler(
  services: ServicePlatformInfo[],
  options: BackupOptions
): Promise<CommandResults<BackupResult>> {
  const serviceResults: BackupResult[] = [];
  const commandStartTime = Date.now();
  
  // Create config for services
  const config: Config = {
    projectRoot: PROJECT_ROOT,
    environment: parseEnvironment(options.environment),
    verbose: options.verbose,
    quiet: options.quiet,
    dryRun: options.dryRun,
  };
  
  // Sort services by backup priority (data services first for consistency)
  const sortedServices = sortServicesByBackupPriority(services);
  
  // Track backup results
  const backupResults = new Map<string, BackupResult>();
  const restoreCommands: { entity: string; command: string }[] = [];
  let totalBackupSize = 0;
  let totalBackupCost = 0;
  
  for (const serviceInfo of sortedServices) {
    
    try {
      // Create service instance
      const service = ServiceFactory.create(
        serviceInfo.name as ServiceName,
        serviceInfo.platform as Platform,
        config,
        { 
          platform: serviceInfo.platform as Platform,
          name: options.name || serviceInfo.config.name || serviceInfo.name,
          port: serviceInfo.config.port || 3000,
          image: serviceInfo.config.image || `semiont/${serviceInfo.name}:latest`
        }
      );
      
      // Backup the service
      const result = await service.backup();
      backupResults.set(serviceInfo.name, result);
      
      // Accumulate statistics
      if (result.backup?.size) {
        totalBackupSize += result.backup.size;
      }
      if (result.cost?.storage) {
        totalBackupCost += result.cost.storage;
        if (result.cost.transfer) {
          totalBackupCost += result.cost.transfer;
        }
      }
      
      // Collect restore command if available
      if (result.restore?.supported && result.restore.command) {
        restoreCommands.push({
          entity: serviceInfo.name,
          command: result.restore.command
        });
      }
      
      // Record result directly - no conversion needed!
      serviceResults.push(result);
      
      // Display result
      if (!options.quiet) {
        if (result.success) {
          printSuccess(`💾 ${serviceInfo.name} (${serviceInfo.platform}) backed up`);
          
          // Show backup ID
          if (result.backupId) {
            console.log(`   🆔 Backup ID: ${result.backupId}`);
          }
          
          // Show backup size and location
          if (result.backup?.size) {
            const sizeMB = Math.round(result.backup.size / 1024 / 1024 * 100) / 100;
            console.log(`   📏 Size: ${sizeMB} MB`);
          }
          
          if (result.backup?.location) {
            console.log(`   📍 Location: ${result.backup.location}`);
          }
          
          // Show backup properties
          if (result.backup?.format) {
            const formatEmoji = {
              'tar': '📦',
              'sql': '🗃️',
              'json': '📄',
              'binary': '💾',
              'snapshot': '📸'
            }[result.backup.format] || '📁';
            console.log(`   ${formatEmoji} Format: ${result.backup.format}`);
          }
          
          if (result.backup?.compression && result.backup.compression !== 'none') {
            console.log(`   🗜️ Compression: ${result.backup.compression}`);
          }
          
          if (result.backup?.encrypted) {
            console.log(`   🔒 Encrypted: Yes`);
          }
          
          // Show retention info
          if (result.retention?.expiresAt) {
            const expireDate = new Date(result.retention.expiresAt).toLocaleDateString();
            console.log(`   ⏰ Expires: ${expireDate}`);
          }
          
          // Show restore info
          if (result.restore?.supported) {
            console.log(`   ♻️ Restore: Supported`);
          } else {
            console.log(`   ❌ Restore: Not supported`);
          }
          
          // Show cost if available
          if (result.cost?.storage || result.cost?.transfer) {
            const totalCost = (result.cost.storage || 0) + (result.cost.transfer || 0);
            console.log(`   💰 Cost: $${totalCost.toFixed(3)} ${result.cost.currency || 'USD'}`);
          }
          
        } else {
          printError(`❌ Failed to backup ${serviceInfo.name}: ${result.error}`);
          
          // For external services, show recommendations
          if (serviceInfo.platform === 'external' && result.metadata?.recommendations) {
            console.log(`   📝 Recommendations:`);
            result.metadata.recommendations.forEach((rec: string) => {
              console.log(`      • ${rec}`);
            });
          }
        }
      }
      
    } catch (error) {
      serviceResults.push({
        entity: serviceInfo.name as ServiceName,
        platform: serviceInfo.platform as Platform,
        success: false,
        backupTime: new Date(),
        backupId: `error-${Date.now()}`,
        error: error instanceof Error ? error.message : String(error)
      });
      
      if (!options.quiet) {
        printError(`Failed to backup ${serviceInfo.name}: ${error}`);
      }
    }
  }
  
  // Summary for multiple services
  if (!options.quiet && services.length > 1) {
    console.log('\n📊 Backup Summary:');
    
    const successful = serviceResults.filter(r => r.success).length;
    const failed = serviceResults.filter(r => !r.success).length;
    
    console.log(`   ✅ Successful: ${successful}`);
    if (failed > 0) console.log(`   ❌ Failed: ${failed}`);
    
    // Platform breakdown
    const platforms = serviceResults.reduce((acc, r) => {
      if (r.success) {
        acc[r.platform] = (acc[r.platform] || 0) + 1;
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
      console.log(`   ${emoji} ${platform}: ${count} backed up`);
    });
    
    // Total storage stats
    if (totalBackupSize > 0) {
      const totalSizeGB = Math.round(totalBackupSize / 1024 / 1024 / 1024 * 100) / 100;
      console.log(`\n📦 Total backup size: ${totalSizeGB} GB`);
    }
    
    if (totalBackupCost > 0) {
      console.log(`💰 Estimated storage cost: $${totalBackupCost.toFixed(2)} USD/month`);
    }
    
    // Restore instructions
    if (restoreCommands.length > 0) {
      console.log('\n♻️  Restore commands:');
      restoreCommands.forEach(({ entity, command }) => {
        console.log(`   ${entity}: ${command}`);
      });
    }
    
    if (successful === services.length) {
      printSuccess('\n🎉 All services backed up successfully!');
    } else if (failed > 0) {
      printWarning(`\n⚠️  ${failed} service(s) failed to backup.`);
    }
  }
  
  if (options.dryRun && !options.quiet) {
    printInfo('\n🔍 This was a dry run. No actual backups were created.');
  }
  
  // Return results directly - no conversion needed!
  return {
    command: 'backup',
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
  } as CommandResults<BackupResult>;
}

/**
 * Sort services by backup priority
 * Generally: data services first (database, filesystem), then applications
 */
function sortServicesByBackupPriority(services: ServicePlatformInfo[]): ServicePlatformInfo[] {
  const backupOrder = ['database', 'filesystem', 'backend', 'mcp', 'frontend', 'agent'];
  
  return services.sort((a, b) => {
    const aIndex = backupOrder.indexOf(a.name);
    const bIndex = backupOrder.indexOf(b.name);
    
    // If not in backup order, put at end
    if (aIndex === -1) return 1;
    if (bIndex === -1) return -1;
    
    return aIndex - bIndex;
  });
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const backupCommand = new CommandBuilder()
  .name('backup')
  .description('Create backups of service data and state')
  .schema(BackupOptionsSchema)
  .requiresServices(true)
  .handler(backupHandler)
  .build();