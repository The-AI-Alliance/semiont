/**
 * Provision Service Types and Interfaces
 * 
 * Defines the provision operation for services - creating infrastructure
 * and resources needed for a service to run.
 */

import type { ServiceName } from './service-interface.js';
import type { Platform } from '../lib/platform-resolver.js';
import type { PlatformResources } from '../lib/platform-resources.js';
/**
 * Result of a provision operation
 */
export interface ProvisionResult {
  entity: ServiceName | string;
  platform: Platform;
  success: boolean;
  provisionTime: Date;
  dependencies?: string[]; // Other services this depends on
  cost?: {
    estimatedMonthly?: number;
    currency?: string;
  };
  resources?: PlatformResources;
  error?: string;
  metadata?: Record<string, any>;
}