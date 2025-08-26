/**
 * Filesystem Service - Refactored with Platform Strategy
 * 
 * Now ~30 lines instead of 245 lines!
 */

import { BaseService } from './base-service.js';
import { CheckResult } from './types.js';
import * as path from 'path';

export class FilesystemServiceRefactored extends BaseService {
  
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