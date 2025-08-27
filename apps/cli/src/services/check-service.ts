/**
 * Check Service Types and Interfaces
 * 
 * Defines the check/status operation for services.
 */

import type { ServiceName } from './service-interface.js';
import type { Platform } from '../lib/platform-resolver.js';
import type { PlatformResources } from '../lib/platform-resources.js';
/**
 * Result of a check/status operation
 */
export interface CheckResult {
  entity: ServiceName | string;
  platform: Platform;
  success: boolean;
  checkTime: Date;
  status: 'running' | 'stopped' | 'unhealthy' | 'unknown';
  stateVerified: boolean; // Did saved state match reality?
  stateMismatch?: {
    expected: any;
    actual: any;
    reason: string;
  };
  health?: {
    endpoint?: string;
    statusCode?: number;
    responseTime?: number;
    healthy: boolean;
    details?: Record<string, any>;
  };
  logs?: {
    recent?: string[];
    errors?: number;
    warnings?: number;
  };
  resources?: PlatformResources;
  error?: string;
  metadata?: Record<string, any>;
}