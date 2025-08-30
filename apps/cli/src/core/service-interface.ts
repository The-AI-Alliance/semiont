/**
 * Core Service Interface
 * 
 * Services provide capabilities and configuration to platforms.
 * They do NOT implement commands - platforms handle all command operations.
 */

import type { Platform } from '../platforms/platform-resolver.js';
import type { ServiceConfig } from '../lib/cli-config.js';
import type { Environment } from '../lib/environment-validator.js';
import type { 
  ServiceRequirements,
  StorageRequirement,
  NetworkRequirement,
  ResourceRequirement,
  BuildRequirement,
  SecurityRequirement
} from './service-requirements.js';

/**
 * Available service types in the system
 */
export type ServiceName = 'backend' | 'frontend' | 'database' | 'filesystem' | 'mcp';

/**
 * Core service interface that all services implement
 * Contains all service-specific information needed for platform operations
 */
export interface Service {
  readonly name: ServiceName;
  readonly platform: Platform;
  readonly config: ServiceConfig;
  readonly environment: Environment;
  readonly projectRoot: string;
  readonly verbose: boolean;
  readonly quiet: boolean;
  readonly dryRun?: boolean;
  readonly forceDiscovery?: boolean;
  
  // Service-specific methods that platforms can call
  getPort(): number;
  getHealthEndpoint(): string;
  getCommand(): string;
  getImage(): string;
  getEnvironmentVariables(): Record<string, string>;
  
  // Requirement methods
  getRequirements(): ServiceRequirements;
  
  // Convenience methods for specific requirements
  needsPersistentStorage(): boolean;
  getStorageRequirements(): StorageRequirement[];
  getNetworkRequirements(): NetworkRequirement | undefined;
  getDependencyServices(): ServiceName[];
  getBuildRequirements(): BuildRequirement | undefined;
  getResourceRequirements(): ResourceRequirement | undefined;
  getSecurityRequirements(): SecurityRequirement | undefined;
  getRequiredSecrets(): string[];
}