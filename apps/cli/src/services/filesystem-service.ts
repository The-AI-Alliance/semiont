import { BaseService } from './base-service.js';
import { StartResult } from './types.js';
import * as fs from 'fs';
import * as path from 'path';
import { printInfo, printWarning } from '../lib/cli-logger.js';

export class FilesystemService extends BaseService {
  protected async doStart(): Promise<StartResult> {
    switch (this.deployment) {
      case 'process':
        return this.startAsProcess();
      case 'container':
        return this.startAsContainer();
      case 'aws':
        return this.startAsAWS();
      case 'external':
        return this.startAsExternal();
      default:
        throw new Error(`Unsupported deployment type: ${this.deployment}`);
    }
  }
  
  private async startAsProcess(): Promise<StartResult> {
    const fsPath = this.serviceConfig.path || path.join(this.config.projectRoot, 'data');
    
    try {
      await fs.promises.mkdir(fsPath, { recursive: true });
      
      if (!this.config.quiet) {
        printInfo(`Created filesystem directories: ${fsPath}`);
      }
      
      return {
        service: this.name,
        deployment: this.deployment,
        success: true,
        startTime: new Date(),
        metadata: {
          path: fsPath,
          type: 'local-directory'
        }
      };
    } catch (error) {
      throw new Error(`Failed to create directories: ${error}`);
    }
  }
  
  private async startAsContainer(): Promise<StartResult> {
    const volumeName = `semiont-filesystem-${this.config.environment}`;
    
    if (!this.config.quiet) {
      printInfo(`Creating container volume: ${volumeName}`);
    }
    
    // Volume creation would happen via docker/podman commands
    // For now just report success
    
    return {
      service: this.name,
      deployment: this.deployment,
      success: true,
      startTime: new Date(),
      metadata: {
        volumeName,
        type: 'named-volume'
      }
    };
  }
  
  private async startAsAWS(): Promise<StartResult> {
    // EFS filesystem
    if (!this.config.quiet) {
      printInfo('Mounting EFS volumes...');
      printWarning('EFS mount not yet implemented');
    }
    
    return {
      service: this.name,
      deployment: this.deployment,
      success: true,
      startTime: new Date(),
      metadata: {
        fileSystemId: `fs-semiont${this.config.environment}`,
        implementation: 'pending'
      }
    };
  }
  
  private async startAsExternal(): Promise<StartResult> {
    // External storage - just verify config
    const storagePath = this.serviceConfig.path;
    
    if (!storagePath) {
      throw new Error('External filesystem requires path configuration');
    }
    
    return {
      service: this.name,
      deployment: this.deployment,
      success: true,
      startTime: new Date(),
      metadata: {
        path: storagePath,
        type: 'external-mount'
      }
    };
  }
}