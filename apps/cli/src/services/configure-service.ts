/**
 * Configure Service Types and Interfaces
 * 
 * Defines the configure operation for services - updating configuration
 * and settings for services.
 */

import type { ServiceName } from './service-interface.js';
import type { Platform } from '../lib/platform-resolver.js';
import type { PlatformResources } from '../lib/platform-resources.js';
/**
 * Result of a configure operation
 */
export interface ConfigureResult {
  entity: ServiceName | string;  // Can be a service or other entity
  platform?: Platform;
  success: boolean;
  status?: string;  // Optional status for legacy commands
  configurationChanges: Array<{
    key: string;
    oldValue?: any;
    newValue: any;
    source: string;
  }>;
  restartRequired: boolean;
  resources?: PlatformResources;
  error?: string;
  metadata?: Record<string, any>;
}