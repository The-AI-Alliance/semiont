/**
 * Core Service Interface
 * 
 * Services provide capabilities and configuration to platforms.
 * They do NOT implement commands - platforms handle all command operations.
 */

import type { Platform } from '../lib/platform-resolver.js';
import type { ServiceContext } from '../platforms/platform-strategy.js';

/**
 * Available service types in the system
 */
export type ServiceName = 'backend' | 'frontend' | 'database' | 'filesystem' | 'mcp';

/**
 * Core service interface that all services implement
 * Services ARE ServiceContexts - they provide the capabilities platforms need
 */
export interface Service extends ServiceContext {
  readonly name: ServiceName;
  readonly platform: Platform;
}