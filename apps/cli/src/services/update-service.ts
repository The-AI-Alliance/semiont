/**
 * Update Service Types and Interfaces
 * 
 * Defines the update operation for services.
 */

import type { ServiceName } from './service-interface.js';
import type { Platform } from '../lib/platform-resolver.js';
import type { PlatformResources } from '../lib/platform-resources.js';
/**
 * Result of an update operation
 */
export interface UpdateResult {
  entity: ServiceName;
  platform: Platform;
  success: boolean;
  updateTime: Date;
  previousVersion?: string;
  newVersion?: string;
  strategy: 'restart' | 'rolling' | 'blue-green' | 'recreate' | 'none';
  downtime?: number; // milliseconds
  resources?: PlatformResources;  error?: string;
  metadata?: Record<string, any>;
}