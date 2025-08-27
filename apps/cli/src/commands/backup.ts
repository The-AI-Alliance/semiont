/**
 * Backup Command - Service-based implementation
 */

import { z } from 'zod';
import { printError, printSuccess, printInfo, printWarning } from '../lib/cli-logger.js';
import { type ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import { CommandResults } from '../lib/command-results.js';
import { CommandBuilder } from '../lib/command-definition.js';
import { BaseOptionsSchema } from '../lib/base-options-schema.js';

// Import new service architecture
import { ServiceFactory } from '../services/service-factory.js';
import { Config, ServiceName, DeploymentType, BackupResult } from '../services/types.js';
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
  services: ServiceDeploymentInfo[],
  options: BackupOptions
): Promise<CommandResults> {
  const serviceResults: any[] = [];
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
  const restoreCommands: { service: string; command: string }[] = [];
  let totalBackupSize = 0;
  let totalBackupCost = 0;
  
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
          service: serviceInfo.name,
          command: result.restore.command
        });
      }
      
      // Record result
      serviceResults.push({
        service: serviceInfo.name,
        success: result.success,
        duration: Date.now() - startTime,
        deployment: serviceInfo.deploymentType,
        backupId: result.backupId,
        backupSize: result.backup?.size,
        backupLocation: result.backup?.location,
        encrypted: result.backup?.encrypted,
        format: result.backup?.format,
        compression: result.backup?.compression,
        retentionPolicy: result.retention?.policy,
        expiresAt: result.retention?.expiresAt,
        restoreSupported: result.restore?.supported,
        cost: result.cost,
        error: result.error
      });
      
      // Display result
      if (!options.quiet) {
        if (result.success) {
          printSuccess(`💾 ${serviceInfo.name} (${serviceInfo.deploymentType}) backed up`);
          
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
          if (serviceInfo.deploymentType === 'external' && result.metadata?.recommendations) {
            console.log(`   📝 Recommendations:`);
            result.metadata.recommendations.forEach((rec: string) => {
              console.log(`      • ${rec}`);
            });
          }
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
        printError(`Failed to backup ${serviceInfo.name}: ${error}`);
      }
    }
  }
  
  // Summary for multiple services
  if (!options.quiet && services.length > 1) {
    console.log('\n📊 Backup Summary:');
    
    const successful = serviceResults.filter((r: any) => r.data.success).length;
    const failed = serviceResults.filter((r: any) => !r.data.success).length;
    
    console.log(`   ✅ Successful: ${successful}`);
    if (failed > 0) console.log(`   ❌ Failed: ${failed}`);
    
    // Platform breakdown
    const platforms = serviceResults.reduce((acc: any, r: any) => {
      if (r.data.success) {
        acc[r.data.deployment] = (acc[r.data.deployment] || 0) + 1;
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
      restoreCommands.forEach(({ service, command }) => {
        console.log(`   ${service}: ${command}`);
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
  
  // Build the CommandResults interface
  const commandResults: CommandResults = {
    command: 'backup',
    environment: options.environment || 'unknown',
    timestamp: new Date(),
    duration: Date.now() - commandStartTime,
    services: serviceResults.map((r: any) => ({
      command: 'backup',
      service: r.service,
      deploymentType: r.data.deployment,
      environment: options.environment || 'unknown',
      timestamp: new Date(),
      duration: r.data.duration,
      success: r.data.success,
      resourceId: { [r.data.deployment]: {} },
      status: r.data.success ? 'completed' : 'failed',
      metadata: r.data,
      error: r.data.error
    })),
    summary: {
      total: serviceResults.length,
      succeeded: serviceResults.filter((r: any) => r.data.success).length,
      failed: serviceResults.filter((r: any) => !r.data.success).length,
      warnings: 0
    },
    executionContext: {
      user: process.env.USER || 'unknown',
      workingDirectory: process.cwd(),
      dryRun: options.dryRun
    }
  };
  
  return commandResults;
}

/**
 * Sort services by backup priority
 * Generally: data services first (database, filesystem), then applications
 */
function sortServicesByBackupPriority(services: ServiceDeploymentInfo[]): ServiceDeploymentInfo[] {
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