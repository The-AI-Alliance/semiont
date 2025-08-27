/**
 * Watch Service Types and Interfaces
 * 
 * Defines the watch operation for services - monitoring logs, metrics,
 * and events in real-time.
 */

import type { ServiceName } from './service-interface.js';
import type { Platform } from '../lib/platform-resolver.js';
import type { PlatformResources } from '../lib/platform-resources.js';
/**
 * Result of a watch operation
 */
export interface WatchResult {
  entity: ServiceName;
  platform: Platform;
  success: boolean;
  status?: string;  // Optional status for legacy commands
  watchType: 'logs' | 'metrics' | 'events';
  streamUrl?: string;
  logLines?: Array<{
    timestamp: Date;
    level: string;
    message: string;
    source?: string;
  }>;
  metrics?: Array<{
    name: string;
    value: number;
    unit: string;
    timestamp: Date;
  }>;
  resources?: PlatformResources;
  error?: string;
  metadata?: Record<string, any>;
}