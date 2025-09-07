/**
 * State Manager - Tracks running service resources across starts/stops
 * 
 * Saves resource identifiers (PIDs, container IDs, etc.) to enable
 * direct resource management instead of searching by port/name.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ServiceName } from './service-discovery.js';
import { PlatformType } from './platform-types.js';
import { PlatformResources } from '../platforms/platform-resources.js';

export interface ServiceState {
  entity: ServiceName;
  platform: PlatformType;
  environment: string;
  startTime: string;
  resources?: PlatformResources;
  endpoint?: string;  // Keep endpoint at top level for easy access
  metadata?: Record<string, any>;
}

export class StateManager {
  private static getStateDir(projectRoot: string): string {
    return path.join(projectRoot, 'state');
  }
  
  private static getStateFile(
    projectRoot: string,
    environment: string,
    service: ServiceName
  ): string {
    const stateDir = this.getStateDir(projectRoot);
    const envDir = path.join(stateDir, environment);
    return path.join(envDir, `${service}.json`);
  }
  
  /**
   * Save service state after successful start
   */
  static async save(
    projectRoot: string,
    environment: string,
    service: ServiceName,
    state: ServiceState
  ): Promise<void> {
    const stateFile = this.getStateFile(projectRoot, environment, service);
    const stateDir = path.dirname(stateFile);
    
    // Ensure state directory exists
    await fs.promises.mkdir(stateDir, { recursive: true });
    
    // Write state file
    await fs.promises.writeFile(
      stateFile,
      JSON.stringify(state, null, 2),
      'utf-8'
    );
  }
  
  /**
   * Load service state for stop/restart operations
   */
  static async load(
    projectRoot: string,
    environment: string,
    service: ServiceName
  ): Promise<ServiceState | null> {
    const stateFile = this.getStateFile(projectRoot, environment, service);
    
    try {
      const content = await fs.promises.readFile(stateFile, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      // State file doesn't exist or is corrupted
      return null;
    }
  }
  
  /**
   * Clear service state after successful stop
   */
  static async clear(
    projectRoot: string,
    environment: string,
    service: ServiceName
  ): Promise<void> {
    const stateFile = this.getStateFile(projectRoot, environment, service);
    
    try {
      await fs.promises.unlink(stateFile);
    } catch {
      // File doesn't exist, that's ok
    }
  }
  
  /**
   * List all services with saved state for an environment
   */
  static async list(
    projectRoot: string,
    environment: string
  ): Promise<ServiceState[]> {
    const envDir = path.join(this.getStateDir(projectRoot), environment);
    
    try {
      const files = await fs.promises.readdir(envDir);
      const states: ServiceState[] = [];
      
      for (const file of files) {
        if (file.endsWith('.json')) {
          const content = await fs.promises.readFile(
            path.join(envDir, file),
            'utf-8'
          );
          try {
            states.push(JSON.parse(content));
          } catch {
            // Skip corrupted state files
          }
        }
      }
      
      return states;
    } catch {
      // Directory doesn't exist
      return [];
    }
  }
  
  /**
   * Clear all state for an environment
   */
  static async clearEnvironment(
    projectRoot: string,
    environment: string
  ): Promise<void> {
    const envDir = path.join(this.getStateDir(projectRoot), environment);
    
    try {
      await fs.promises.rm(envDir, { recursive: true, force: true });
    } catch {
      // Directory doesn't exist, that's ok
    }
  }
  
  /**
   * Validate that a saved PID is still running
   */
  static isProcessRunning(pid: number): boolean {
    try {
      // Sending signal 0 checks if process exists without affecting it
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  
  /**
   * Clean up stale state files (where process/container no longer exists)
   */
  static async cleanup(
    projectRoot: string,
    environment: string
  ): Promise<void> {
    const states = await this.list(projectRoot, environment);
    
    for (const state of states) {
      let isStale = false;
      
      // Check if resource still exists
      if (state.resources) {
        switch (state.resources.platform) {
          case 'posix':
            if (state.resources.data.pid && !this.isProcessRunning(state.resources.data.pid)) {
              isStale = true;
            }
            break;
          // TODO: Add container existence check
          // TODO: Add AWS resource existence check
        }
      }
      
      if (isStale) {
        await this.clear(projectRoot, environment, state.entity);
      }
    }
  }
}