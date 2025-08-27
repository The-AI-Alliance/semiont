/**
 * Restart Service Types and Interfaces
 * 
 * Defines the restart operation for services - stopping and starting
 * services with minimal downtime.
 */

import type { ServiceName } from './service-interface.js';
import type { Platform } from '../lib/platform-resolver.js';
import type { PlatformResources } from '../lib/platform-resources.js';
/**
 * Result of a restart operation
 */
export interface RestartResult {
  entity: ServiceName;
  platform: Platform;
  success: boolean;
  status?: string;  // Optional status for legacy commands
  stopTime: Date;
  startTime: Date;
  downtime: number; // milliseconds
  gracefulRestart: boolean;
  resources?: PlatformResources;
  error?: string;
  metadata?: Record<string, any>;
}