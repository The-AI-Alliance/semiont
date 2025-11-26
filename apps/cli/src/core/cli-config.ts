/**
 * CLI Configuration Types
 * 
 * Central location for CLI-wide configuration types and interfaces.
 * These are not service-specific but apply to the entire CLI operation.
 */

import type { Environment } from '@semiont/core';
import type {
  BackendServiceConfig,
  FrontendServiceConfig,
  DatabaseServiceConfig,
  GraphServiceConfig,
  FilesystemServiceConfig,
  InferenceServiceConfig,
  McpServiceConfig
} from '@semiont/core';

/**
 * Global CLI configuration passed to all commands and services
 */
export interface Config {
  projectRoot: string;
  environment: Environment;
  verbose: boolean;
  quiet: boolean;
  dryRun?: boolean;
  forceDiscovery?: boolean;
}

/**
 * Service configuration - uses schema-generated types
 */
export type ServiceConfig =
  | BackendServiceConfig
  | FrontendServiceConfig
  | DatabaseServiceConfig
  | GraphServiceConfig
  | FilesystemServiceConfig
  | InferenceServiceConfig
  | McpServiceConfig;