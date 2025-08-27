/**
 * Stop Service Types and Interfaces
 * 
 * Defines the stop operation for services.
 */

import type { ServiceName } from './service-interface.js';
import type { Platform } from '../lib/platform-resolver.js';
import type { PlatformResources } from '../lib/platform-resources.js';

/**
 * Result of a stop operation
 */
export interface StopResult {
  entity: ServiceName;
  platform: Platform;
  success: boolean;
  stopTime: Date;
  gracefulShutdown?: boolean;
  resources?: PlatformResources;  // Resources that were stopped
  error?: string;
  metadata?: Record<string, any>;
}