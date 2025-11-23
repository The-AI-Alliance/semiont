/**
 * CLI Configuration Types
 * 
 * Central location for CLI-wide configuration types and interfaces.
 * These are not service-specific but apply to the entire CLI operation.
 */

import type { Environment } from '@semiont/core';
import type { PlatformType } from '@semiont/core';

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
 * Base service configuration (common fields across all service types)
 */
interface BaseServiceConfig {
  platform: PlatformType;
  description?: string;

  // Service type discriminator
  type?: string;

  // Common runtime fields
  port?: number;
  command?: string;
  image?: string;

  // Connection fields (database, graph, inference services)
  host?: string;
  uri?: string;
  database?: string;
  name?: string;
  username?: string;
  password?: string;

  // Web service fields
  url?: string;
  publicURL?: string;
  corsOrigin?: string;
  backendPort?: number;
  siteName?: string;

  // Filesystem fields
  path?: string;

  // Graph service fields
  janusgraphVersion?: string;
  javaOptions?: string;
  heapSize?: string;
  pageCacheSize?: string;
  noAuth?: boolean;
  dataPath?: string;
  index?: string;

  // Inference service fields
  model?: string;
  maxTokens?: number;
  endpoint?: string;
  apiKey?: string;
  organization?: string;

  // Environment and labeling
  env?: Record<string, string> | string;  // Can be object or string path
  environment?: Record<string, string>;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;

  // Resource configuration
  resources?: {
    cpu?: string;
    memory?: string;
    gpu?: number;
    gpus?: number;
    replicas?: number;
    ephemeralStorage?: string;
    memoryReservation?: string;
  };

  // Storage configuration
  // For graph services: can be string (JanusGraph backend like "cassandra")
  // For other services: structured volume configuration
  storage?: string | Array<{
    volumeName: string;
    mountPath: string;
    size?: string;
    persistent?: boolean;
    type?: string;
  }> | {
    volumeName: string;
    mountPath: string;
    size?: string;
    persistent?: boolean;
    type?: string;
  };

  // Allow volume storage via explicit field name for graph services
  volumes?: Array<{
    volumeName: string;
    mountPath: string;
    size?: string;
    persistent?: boolean;
    type?: string;
  }>;

  // Other service-specific fields
  projectRoot?: string;
  semiontRepo?: string;
  redisUrl?: string;
  memory?: string;
  cpu?: string;
  databaseUrl?: string;
  storageSize?: string;
  user?: string;
  backendUrl?: string;

  // Networking
  ports?: number[];
  protocol?: 'tcp' | 'http' | 'https' | string;
  loadBalancer?: boolean;
  healthCheck?: string;
  healthCheckPort?: number;
  healthEndpoint?: string;
  domains?: string[];

  // Build configuration
  build?: boolean;
  dockerfile?: string;
  buildContext?: string;
  buildArgs?: Record<string, string>;
  buildTarget?: string;
  prebuilt?: boolean;
  noCache?: boolean;

  // Security
  security?: {
    readOnlyRootFilesystem?: boolean;
    runAsNonRoot?: boolean;
    runAsUser?: number;
    runAsGroup?: number;
    capabilities?: {
      add?: string[];
      drop?: string[];
    } | string[];
    privileged?: boolean;
    allowPrivilegeEscalation?: boolean;
  };
  secrets?: string[];

  // Dependencies
  dependencies?: string[];
  externalDependencies?: string[];

  // Service metadata
  serviceType?: string;

  // Deployment
  wait?: boolean;
  timeout?: number;
  tag?: string;

  // Stack management
  stackType?: string;
  destroy?: boolean;
  force?: boolean;

  // External platform fields
  logsEndpoint?: string;
  logs?: boolean;
}

/**
 * Web service configuration (frontend, backend)
 */
export interface WebServiceConfig extends BaseServiceConfig {}

/**
 * Database service configuration
 */
export interface DatabaseServiceConfig extends BaseServiceConfig {}

/**
 * Graph database service configuration
 */
export interface GraphServiceConfig extends BaseServiceConfig {}

/**
 * Filesystem service configuration
 */
export interface FilesystemServiceConfig extends BaseServiceConfig {}

/**
 * Inference service configuration
 */
export interface InferenceServiceConfig extends BaseServiceConfig {}

/**
 * Service-specific configuration
 * All service configs inherit from BaseServiceConfig which contains all possible fields
 * This avoids union type narrowing issues while still providing type safety
 */
export type ServiceConfig =
  | WebServiceConfig
  | DatabaseServiceConfig
  | GraphServiceConfig
  | FilesystemServiceConfig
  | InferenceServiceConfig;