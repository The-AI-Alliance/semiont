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
 * Service configuration - uses schema-generated types.
 * OllamaProviderConfig and AnthropicProviderConfig are excluded from this union
 * because they lack the common fields (env, environment) that BaseService accesses.
 * InferenceService handles both provider types internally via its own cast.
 */
export type ServiceConfig =
  | BackendServiceConfig
  | FrontendServiceConfig
  | DatabaseServiceConfig
  | GraphServiceConfig
  | McpServiceConfig;