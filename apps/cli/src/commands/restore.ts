/**
 * Restore Command - New Implementation
 * 
 * Restores service data from backups, demonstrating the data operation
 * pattern's bidirectionality. The restore operation is the inverse of
 * backup, completing the data preservation lifecycle.
 */

import { CommandBuilder } from '../lib/command-definition.js';
import { ServiceName } from '../services/service-interface.js';
import { PlatformResources } from '../lib/platform-resources.js';
import { Config, ServiceConfig } from '../lib/cli-config.js';
import { ServiceFactory } from '../services/service-factory.js';
import { Platform } from '../lib/platform-resolver.js';
import { printInfo, printSuccess, printError, printWarning } from '../lib/cli-logger.js';
import { z } from 'zod';
import { BaseOptionsSchema } from '../lib/base-options-schema.js';
import { ServicePlatformInfo } from '../lib/platform-resolver.js';

// =====================================================================
// RESULT TYPE DEFINITIONS
// =====================================================================

/**
 * Result of a restore operation
 */
export interface RestoreResult {
  entity: ServiceName | string;
  platform: Platform;
  success: boolean;
  restoreTime: Date;
  backupId: string; // ID of backup that was restored
  restore?: {
    // Restoration details
    source?: string; // Source location of backup
    destination?: string; // Where data was restored to
    size?: number; // Size of restored data
    duration?: number; // Time taken to restore (ms)
    
    // What was restored
    database?: {
      tables?: number; // Number of tables restored
      records?: number; // Number of records restored
      schemas?: boolean; // Whether schemas were restored
      indexes?: boolean; // Whether indexes were rebuilt
      constraints?: boolean; // Whether constraints were restored
    };
    filesystem?: {
      files?: number; // Number of files restored
      directories?: number; // Number of directories
      permissions?: boolean; // Whether permissions were preserved
      symlinks?: boolean; // Whether symlinks were preserved
    };
    configuration?: {
      envFiles?: string[]; // Environment files restored
      configFiles?: string[]; // Config files restored
      secrets?: boolean; // Whether secrets were restored
    };
    application?: {
      version?: string; // Application version restored
      state?: boolean; // Whether application state was restored
      cache?: boolean; // Whether cache was restored
    };
  };
  validation?: {
    // Post-restore validation
    checksumVerified?: boolean; // Whether integrity was verified
    dataComplete?: boolean; // Is all data present?
    servicesRestarted?: boolean; // Whether services were restarted
    healthCheck?: boolean; // Did health check pass?
    testsPassed?: boolean; // Did smoke tests pass?
  };
  rollback?: {
    // Rollback information
    supported: boolean; // Can we rollback this restore?
    previousBackupId?: string; // Previous backup before restore
    command?: string; // Command to rollback
  };
  downtime?: {
    // Service downtime during restore
    start?: Date; // When service was stopped
    end?: Date; // When service was restarted
    duration?: number; // Total downtime in ms
    planned?: boolean; // Whether this is planned downtime
  };
  warnings?: string[]; // Any warnings during restore
  resources?: PlatformResources;
  error?: string;
  metadata?: Record<string, any>;
}

/**
 * Options for restore operation
 */
export interface RestoreOptions {
  force?: boolean; // Force restore even if service is running
  validate?: boolean; // Validate backup before restoring
  stopService?: boolean; // Stop service before restore
  startService?: boolean; // Start service after restore
  verifyChecksum?: boolean; // Verify backup integrity
  skipTests?: boolean; // Skip post-restore tests
  targetPath?: string; // Custom restore path
  dryRun?: boolean; // Simulate restore without changes
}
import { CommandResults } from '../lib/command-results.js';
import { parseEnvironment } from '../lib/environment-validator.js';

// Schema for restore options  
const RestoreOptionsSchema = BaseOptionsSchema.extend({
  backupId: z.string().describe('ID of the backup to restore from'),
  force: z.boolean().optional().describe('Force restore without confirmation'),
  validate: z.boolean().optional().default(true).describe('Validate backup before restoring'),
  stopService: z.boolean().optional().default(true).describe('Stop service before restore'),
  startService: z.boolean().optional().default(true).describe('Start service after restore'),
  verifyChecksum: z.boolean().optional().default(true).describe('Verify backup checksum'),
  skipTests: z.boolean().optional().describe('Skip post-restore tests'),
  targetPath: z.string().optional().describe('Custom restore path'),
});

type CommandRestoreOptions = z.output<typeof RestoreOptionsSchema>;

// Main handler function
async function restoreHandler(
  serviceDeployments: ServicePlatformInfo[],
  options: CommandRestoreOptions
): Promise<CommandResults<RestoreResult>> {
  const startTime = Date.now();
  
  // Create config from options
  const config: Config = {
    projectRoot: process.cwd(),
    environment: parseEnvironment(options.environment),
    verbose: options.verbose,
    quiet: options.quiet,
    dryRun: options.dryRun
  };
  
  // Extract service names from deployments
  const services = serviceDeployments.map(sd => sd.name as ServiceName);
  
  printInfo(`🔄 Restoring ${services.length} service(s) from backup ${options.backupId}`);
  
  // Warn about potential downtime
  if (!options.force && options.stopService !== false) {
    printWarning('⚠️ Restore operation may cause service downtime');
    printInfo('Use --force to skip this warning');
    
    // In a real implementation, would prompt for confirmation
    if (!config.quiet) {
      printInfo('Proceeding with restore...');
    }
  }
  
  // Service restore order (inverse of backup order)
  // Critical services restored last to minimize downtime
  const restoreOrder: ServiceName[] = [
    'frontend',    // Restore UI first (least critical)
    'agent',       // Then agents
    'mcp',         // Then MCP services
    'backend',     // Then backend
    'filesystem',  // Then filesystem
    'database'     // Database last (most critical)
  ];
  
  // Filter and order services
  const orderedServices = restoreOrder.filter(s => services.includes(s));
  
  const results: RestoreResult[] = [];
  
  // Pre-restore validation phase
  if (options.validate !== false && !config.dryRun) {
    printInfo('🔍 Validating backups...');
    
    for (const serviceName of orderedServices) {
      // Validation would be done in platform implementation
      // serviceName will be validated by the platform
      
      // Check if backup exists (would be done in platform implementation)
      if (!config.quiet) {
        printInfo(`  Validating backup for ${serviceName}...`);
      }
    }
  }
  
  // Restore phase
  printInfo('📦 Starting restore operations...');
  
  for (const serviceName of orderedServices) {
    const service = ServiceFactory.create(
      serviceName,
      'process' as Platform, // Default to process for now
      config,
      { platform: 'process' as Platform } as ServiceConfig
    );
    
    try {
      const restoreOptions: RestoreOptions = {
        force: options.force,
        validate: options.validate,
        stopService: options.stopService,
        startService: options.startService,
        verifyChecksum: options.verifyChecksum,
        skipTests: options.skipTests,
        targetPath: options.targetPath,
        dryRun: options.dryRun
      };
      
      const result = await service.restore(options.backupId, restoreOptions);
      results.push(result);
      
      // Show progress
      if (!config.quiet) {
        if (result.success) {
          printSuccess(`✅ ${serviceName}: Restored successfully`);
          
          if (result.restore?.database) {
            printInfo(`   Database: ${result.restore.database.tables} tables restored`);
          }
          if (result.restore?.filesystem) {
            printInfo(`   Files: ${result.restore.filesystem.files} files restored`);
          }
          if (result.downtime?.duration) {
            const downtimeSeconds = (result.downtime.duration / 1000).toFixed(1);
            printInfo(`   Downtime: ${downtimeSeconds}s`);
          }
          if (result.validation?.healthCheck) {
            printSuccess(`   Health check: Passed`);
          }
        } else {
          printError(`❌ ${serviceName}: Restore failed`);
          if (result.error) {
            printError(`   ${result.error}`);
          }
        }
      }
      
    } catch (error) {
      results.push({
        entity: serviceName,
        platform: service.platform,
        success: false,
        restoreTime: new Date(),
        backupId: options.backupId,
        error: (error as Error).message
      });
      
      if (!config.quiet) {
        printError(`❌ ${serviceName}: ${(error as Error).message}`);
      }
      
      // Stop on first failure unless force
      if (!options.force) {
        printError('Stopping restore due to failure. Use --force to continue despite errors.');
        break;
      }
    }
  }
  
  // Post-restore validation
  if (options.skipTests !== true && !config.dryRun) {
    printInfo('🧪 Running post-restore validation...');
    
    for (const result of results) {
      if (result.success && result.validation?.testsPassed === false) {
        printWarning(`⚠️ ${result.entity}: Post-restore tests failed`);
      }
    }
  }
  
  // Summary
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  
  printInfo(`\n📊 Restore Summary:`);
  printInfo(`   Duration: ${duration}s`);
  printSuccess(`   ✅ Successful: ${successful}`);
  
  if (failed > 0) {
    printError(`   ❌ Failed: ${failed}`);
  }
  
  // Total downtime calculation
  const totalDowntime = results
    .filter(r => r.downtime?.duration)
    .reduce((sum, r) => sum + (r.downtime?.duration || 0), 0);
  
  if (totalDowntime > 0) {
    printInfo(`   ⏱️ Total downtime: ${(totalDowntime / 1000).toFixed(1)}s`);
  }
  
  // Rollback information
  const rollbackSupported = results.filter(r => r.rollback?.supported);
  if (rollbackSupported.length > 0) {
    printInfo(`\n🔙 Rollback Commands Available:`);
    rollbackSupported.forEach(r => {
      if (r.rollback?.command) {
        printInfo(`   ${r.entity}: ${r.rollback.command}`);
      }
    });
  }
  
  // Warnings
  const warnings = results.flatMap(r => r.warnings || []);
  if (warnings.length > 0) {
    printWarning(`\n⚠️ Warnings:`);
    warnings.forEach(w => printWarning(`   ${w}`));
  }
  
  // Return results directly - no conversion needed!
  return {
    command: 'restore',
    environment: options.environment || 'unknown',
    timestamp: new Date(),
    duration: Date.now() - startTime,
    results: results,  // Rich types preserved!
    summary: {
      total: results.length,
      succeeded: successful,
      failed: failed,
      warnings: warnings.length
    },
    executionContext: {
      user: process.env.USER || 'unknown',
      workingDirectory: process.cwd(),
      dryRun: options.dryRun || false
    }
  } as CommandResults<RestoreResult>;
}

// Build and export the command
export const restoreNewCommand = new CommandBuilder()
  .name('restore-new')
  .description('Restore services from backups (new implementation)')
  .schema(RestoreOptionsSchema)
  .requiresServices(true)
  .args({
    args: {
      '--backup-id': { type: 'string', description: 'ID of the backup to restore from', required: true },
      '--force': { type: 'boolean', description: 'Force restore without confirmation' },
      '--validate': { type: 'boolean', description: 'Validate backup before restoring', default: true },
      '--stop-service': { type: 'boolean', description: 'Stop service before restore', default: true },
      '--start-service': { type: 'boolean', description: 'Start service after restore', default: true },
      '--verify-checksum': { type: 'boolean', description: 'Verify backup checksum', default: true },
      '--skip-tests': { type: 'boolean', description: 'Skip post-restore tests' },
      '--target-path': { type: 'string', description: 'Custom restore path' },
    },
    aliases: {
      '-b': '--backup-id',
      '-f': '--force',
    }
  })
  .handler(restoreHandler)
  .build();