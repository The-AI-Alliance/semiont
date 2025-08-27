/**
 * Restore Service Types and Interfaces
 * 
 * Defines the restore operation for services - the ability to restore
 * from backups and recover previous states.
 */

import type { ServiceName } from './service-interface.js';
import type { Platform } from '../lib/platform-resolver.js';
import type { PlatformResources } from '../lib/platform-resources.js';
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
  resources?: PlatformResources;  error?: string;
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