/**
 * Backup Service Types and Interfaces
 * 
 * Defines the backup operation for services - creating snapshots
 * and backups of data, configuration, and state.
 */

import type { ServiceName } from './service-interface.js';
import type { Platform } from '../lib/platform-resolver.js';
import type { PlatformResources } from '../lib/platform-resources.js';
/**
 * Result of a backup operation
 */
export interface BackupResult {
  entity: ServiceName;
  platform: Platform;
  success: boolean;
  backupTime: Date;
  backupId: string; // Unique identifier for this backup
  backup?: {
    // Backup artifacts and metadata
    size?: number; // Size in bytes
    location?: string; // Where the backup is stored
    format?: 'tar' | 'sql' | 'json' | 'binary' | 'snapshot';
    compression?: 'gzip' | 'bzip2' | 'xz' | 'none';
    encrypted?: boolean;
    checksum?: string; // For integrity verification
    // Backup content types
    database?: {
      type: 'postgresql' | 'mysql' | 'sqlite' | 'mongodb';
      schema?: boolean;
      data?: boolean;
      tables?: string[];
    };
    filesystem?: {
      paths?: string[];
      excludePatterns?: string[];
      preservePermissions?: boolean;
    };
    configuration?: {
      envFiles?: string[];
      configMaps?: string[];
      secrets?: boolean; // Whether secrets were backed up
    };
    application?: {
      source?: boolean;
      assets?: boolean;
      logs?: boolean;
    };
  };
  retention?: {
    expiresAt?: Date;
    policy?: string; // e.g., "daily", "weekly", "monthly"
    autoCleanup?: boolean;
  };
  restore?: {
    supported: boolean;
    command?: string;
    requirements?: string[]; // Prerequisites for restoration
  };
  cost?: {
    storage?: number; // Storage cost
    transfer?: number; // Transfer cost
    currency?: string;
  };
  resources?: PlatformResources;  error?: string;
  metadata?: Record<string, any>;
}