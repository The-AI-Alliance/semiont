/**
 * Core Service Interface
 * 
 * Services provide capabilities and configuration to platforms.
 * They do NOT implement commands - platforms handle all command operations.
 * 
 * This interface defines the contract that all services must implement,
 * whether they extend BaseService or provide a custom implementation.
 */

import type { PlatformType } from '@semiont/core';
import type { ServiceConfig } from './cli-config.js';
import type { Environment } from '@semiont/core';
import type { ServiceName } from './service-discovery.js';
import type { 
  ServiceRequirements,
  StorageRequirement,
  NetworkRequirement,
  ResourceRequirement,
  BuildRequirement,
  SecurityRequirement
} from './service-requirements.js';

/**
 * Core service interface that all services implement
 * Contains all service-specific information needed for platform operations
 */
export interface Service {
  readonly name: ServiceName;
  readonly platform: PlatformType;
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