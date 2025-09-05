/**
 * CLI Configuration Types
 * 
 * Central location for CLI-wide configuration types and interfaces.
 * These are not service-specific but apply to the entire CLI operation.
 */

import type { Environment } from './environment-validator.js';
import type { Platform } from './platform-resolver.js';

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
 * Service-specific configuration
 */
export interface ServiceConfig {
  platform: Platform;
  port?: number;
  command?: string;
  image?: string;
  host?: string;
  path?: string;
  name?: string;
  user?: string;
  password?: string;
  [key: string]: any;
}