/**
 * Service Factory
 *
 * Creates service instances using the platform strategy pattern.
 * Fails hard on unknown service types.
 */

import { Service } from '../core/service-interface.js';
import { ServiceName } from '../core/service-discovery.js';
import { Config, ServiceConfig } from '../core/cli-config.js';
import { PlatformType, EnvironmentConfig } from '@semiont/core';
import { BackendService } from './backend-service.js';
import { FrontendService } from './frontend-service.js';
import { DatabaseService } from './database-service.js';
import { GraphService } from './graph-service.js';
import { MCPService } from './mcp-service.js';
import { InferenceService } from './inference-service.js';
import { ProxyService } from './proxy-service.js';

const SUPPORTED_SERVICES = ['backend', 'frontend', 'database', 'graph', 'mcp', 'inference', 'proxy'] as const;

export class ServiceFactory {
  /**
   * Create a service instance with platform strategy pattern
   */
  static create(
    name: ServiceName,
    platform: PlatformType,
    config: Config,
    envConfig: EnvironmentConfig,
    serviceConfig: ServiceConfig
  ): Service {
    const runtimeFlags = {
      verbose: config.verbose,
      quiet: config.quiet,
      dryRun: config.dryRun,
      forceDiscovery: config.forceDiscovery
    };

    switch (name) {
      case 'backend':
        return new BackendService(name, platform, envConfig, serviceConfig, runtimeFlags);

      case 'frontend':
        return new FrontendService(name, platform, envConfig, serviceConfig, runtimeFlags);

      case 'database':
        return new DatabaseService(name, platform, envConfig, serviceConfig, runtimeFlags);

      case 'graph':
        return new GraphService('graph', platform, envConfig, serviceConfig, runtimeFlags);

      case 'mcp':
        return new MCPService(name, platform, envConfig, serviceConfig, runtimeFlags);

      case 'inference':
        return new InferenceService(name, platform, envConfig, serviceConfig, runtimeFlags);

      case 'proxy':
        return new ProxyService('proxy', platform, envConfig, serviceConfig, runtimeFlags);

      default:
        throw new Error(
          `Unknown service type: '${name}'. Supported services: ${SUPPORTED_SERVICES.join(', ')}`
        );
    }
  }
}