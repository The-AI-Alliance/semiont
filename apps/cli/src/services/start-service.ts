/**
 * Start Service Types and Interfaces
 * 
 * Defines the start operation for services.
 */

import type { ServiceName } from './service-interface.js';
import type { Platform } from '../lib/platform-resolver.js';
import type { PlatformResources } from '../lib/platform-resources.js';

/**
 * Result of a start operation
 */
export interface StartResult {
  entity: ServiceName | string;
  platform: Platform;
  success: boolean;
  startTime: Date;
  endpoint?: string;
  resources?: PlatformResources;  // Platform-specific resource identifiers
  error?: string;
  metadata?: Record<string, any>;
}