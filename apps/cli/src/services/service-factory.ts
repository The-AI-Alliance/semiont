/**
 * Service Factory
 *
 * Creates service instances using the platform strategy pattern.
 * Fails hard on unknown service types.
 */

import { Service } from '../core/service-interface.js';
import { ServiceName } from '../core/service-discovery.js';
import { Config, ServiceConfig } from '../core/cli-config.js';
import { PlatformType, EnvironmentConfig, OllamaProviderConfig, AnthropicProviderConfig } from '@semiont/core';
import { BackendService } from './backend-service.js';
import { FrontendService } from './frontend-service.js';
import { DatabaseService } from './database-service.js';
import { GraphService } from './graph-service.js';
import { MCPService } from './mcp-service.js';
import { InferenceService } from './inference-service.js';
import { ProxyService } from './proxy-service.js';

const SUPPORTED_SERVICES = ['backend', 'frontend', 'database', 'graph', 'mcp', 'inference', 'proxy'] as const;

type InferenceProviderConfig = OllamaProviderConfig | AnthropicProviderConfig;

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

      case 'proxy':
        return new ProxyService('proxy', platform, envConfig, serviceConfig, runtimeFlags);

      case 'inference': {
        const inferenceType = (serviceConfig as any).inferenceType as string;
        if (!inferenceType) {
          throw new Error(`inference service config is missing 'inferenceType'`);
        }
        return new InferenceService(name, platform, envConfig, serviceConfig as unknown as InferenceProviderConfig, runtimeFlags, inferenceType);
      }

      default:
        throw new Error(
          `Unknown service type: '${name}'. Supported services: ${SUPPORTED_SERVICES.join(', ')}`
        );
    }
  }

  /**
   * Create one InferenceService instance per configured inference provider.
   * Commands that handle --service inference call this instead of create().
   */
  static createInferenceServices(
    platform: PlatformType,
    config: Config,
    envConfig: EnvironmentConfig,
  ): InferenceService[] {
    const runtimeFlags = {
      verbose: config.verbose,
      quiet: config.quiet,
      dryRun: config.dryRun,
      forceDiscovery: config.forceDiscovery,
    };
    return Object.entries(envConfig.inference ?? {}).map(([inferenceType, providerConfig]) =>
      new InferenceService(
        'inference',
        platform,
        envConfig,
        providerConfig as InferenceProviderConfig,
        runtimeFlags,
        inferenceType,
      )
    );
  }
}