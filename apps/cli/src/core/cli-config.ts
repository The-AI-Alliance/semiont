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
  projectRoot: string | null;
  environment: Environment;
  verbose: boolean;
  quiet: boolean;
  dryRun?: boolean;
  forceDiscovery?: boolean;
}

/**
 * Service configuration - uses schema-generated types.
 * OllamaProviderConfig, AnthropicProviderConfig, VectorsServiceConfig, and
 * EmbeddingConfig are excluded from this union because they lack the common
 * fields (env, environment, command) that BaseService accesses.
 * InferenceService, VectorsService, and EmbeddingService handle their
 * config types internally via their own casts.
 */
export type ServiceConfig =
  | BackendServiceConfig
  | FrontendServiceConfig
  | DatabaseServiceConfig
  | GraphServiceConfig
  | McpServiceConfig;