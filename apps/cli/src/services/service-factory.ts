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
import { EmbeddingService } from './embedding-service.js';
import { VectorsService } from './vectors-service.js';

const SUPPORTED_SERVICES = ['backend', 'frontend', 'database', 'graph', 'mcp', 'inference', 'embedding', 'vectors'] as const;

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

      case 'vectors':
        return new VectorsService(name, platform, envConfig, serviceConfig as import('@semiont/core').VectorsServiceConfig, runtimeFlags);

      case 'embedding': {
        const embeddingConfig = envConfig.services.vectors?.embedding;
        if (!embeddingConfig) {
          throw new Error('embedding service requires vectors.embedding config');
        }
        return new EmbeddingService('embedding', platform, envConfig, embeddingConfig, runtimeFlags);
      }

      case 'inference':
      default: {
        // Handle both 'inference' (legacy) and 'inference.<provider>' (e.g. 'inference.anthropic')
        const isInference = name === 'inference' || name.startsWith('inference.');
        if (isInference) {
          const inferenceType = (serviceConfig as any).inferenceType as string
            ?? (name.includes('.') ? name.slice(name.indexOf('.') + 1) : undefined);
          if (!inferenceType) {
            throw new Error(`inference service config is missing 'inferenceType'`);
          }
          return new InferenceService('inference', platform, envConfig, serviceConfig as unknown as InferenceProviderConfig, runtimeFlags, inferenceType);
        }
        throw new Error(
          `Unknown service type: '${name}'. Supported services: ${SUPPORTED_SERVICES.join(', ')}`
        );
      }
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

  /**
   * Create an EmbeddingService if vectors.embedding is configured.
   */
  static createEmbeddingService(
    platform: PlatformType,
    config: Config,
    envConfig: EnvironmentConfig,
  ): EmbeddingService | null {
    const embedding = envConfig.services.vectors?.embedding;
    if (!embedding) return null;
    return new EmbeddingService(
      'embedding',
      platform,
      envConfig,
      embedding,
      {
        verbose: config.verbose,
        quiet: config.quiet,
        dryRun: config.dryRun,
        forceDiscovery: config.forceDiscovery,
      },
    );
  }
}