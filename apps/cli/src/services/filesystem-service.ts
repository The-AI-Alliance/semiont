/**
 * Filesystem Service
 * 
 * Provides shared filesystem storage for services that need persistent,
 * mountable file storage. This service manages traditional filesystem
 * access rather than object storage APIs.
 * 
 * Common Use Cases:
 * - Shared data directories between services
 * - Application file uploads and downloads
 * - Configuration and state files
 * - Media and asset storage
 * - Database file storage
 * 
 * Default Requirements:
 * - Compute: Minimal (filesystem is passive storage)
 * - Network: No dedicated ports (accessed via mount)
 * - Storage: 100GB persistent for file storage
 * - Backup: Regular snapshots of file data
 * 
 * Platform Adaptations:
 * - Process: Local directory on host filesystem
 * - Container: Docker volume mounts shared between containers
 * - AWS: EFS (Elastic File System) mounted by ECS tasks
 * - External: Network-attached storage (NAS/NFS)
 * 
 * Provides POSIX-compliant filesystem semantics, allowing services
 * to read and write files using standard filesystem APIs. The Semiont
 * backend and other services mount this filesystem directly.
 */

import { BaseService } from '../core/base-service.js';
import { ServiceRequirements, RequirementPresets } from '../core/service-requirements.js';
import { CheckResult } from '../core/commands/check.js';
import * as path from 'path';

export class FilesystemService extends BaseService {
  
  // =====================================================================
  // Service Requirements
  // =====================================================================
  
  override getRequirements(): ServiceRequirements {
    // Filesystem service needs persistent storage
    return RequirementPresets.statefulDatabase(); // Similar storage needs
  }
  
  // =====================================================================
  // Service-specific configuration
  // =====================================================================
  
  override getPort(): number {
    return 0; // Filesystem doesn't use ports
  }
  
  override getHealthEndpoint(): string {
    return ''; // Filesystem doesn't have HTTP endpoints
  }
  
  override getCommand(): string {
    return ''; // Filesystem doesn't run as a process
  }
  
  override getImage(): string {
    return ''; // Filesystem typically uses volumes, not images
  }
  
  override getEnvironmentVariables(): Record<string, string> {
    const baseEnv = super.getEnvironmentVariables();
    
    return {
      ...baseEnv,
      DATA_PATH: this.getDataPath()
    };
  }
  
  // =====================================================================
  // Service-specific hooks
  // =====================================================================
  
  protected override async checkHealth(): Promise<CheckResult['health']> {
    // Filesystem health is whether the path is accessible
    const dataPath = this.getDataPath();
    
    try {
      const fs = await import('fs');
      await fs.promises.access(dataPath, fs.constants.R_OK | fs.constants.W_OK);
      
      return {
        healthy: true,
        details: { 
          message: 'Filesystem accessible',
          path: dataPath
        }
      };
    } catch {
      return {
        healthy: false,
        details: { 
          message: 'Filesystem not accessible',
          path: dataPath
        }
      };
    }
  }
  
  // =====================================================================
  // Helper methods
  // =====================================================================
  
  private getDataPath(): string {
    return this.config.path || path.join(this.config.projectRoot, 'data');
  }
}