/**
 * Embedding Service - Handles embedding model providers (Ollama, Voyage)
 *
 * Manages the embedding model lifecycle independently of inference providers.
 * Reads config from environments.<env>.embedding.
 *
 * Platform Adaptations:
 * - external: Pull models via HTTP API (Ollama) or validate API key (Voyage)
 * - posix: Pull models via local `ollama pull` command
 * - container: Pull models via `docker exec` into Ollama container
 */

import { BaseService } from '../core/base-service.js';
import { ServiceRequirements, RequirementPresets } from '../core/service-requirements.js';
import { COMMAND_CAPABILITY_ANNOTATIONS } from '../core/service-command-capabilities.js';
import { SERVICE_TYPES } from '../core/service-types.js';
import type { EnvironmentConfig } from '@semiont/core';
import type { ServiceName } from '../core/service-discovery.js';
import type { PlatformType } from '@semiont/core';
import type { ServiceConfig } from '../core/cli-config.js';

export interface EmbeddingConfig {
  type: 'voyage' | 'ollama';
  model: string;
  apiKey?: string;
  baseURL?: string;
  endpoint?: string;
}

export class EmbeddingService extends BaseService {
  constructor(
    name: ServiceName,
    platform: PlatformType,
    envConfig: EnvironmentConfig,
    private readonly embeddingConfig: EmbeddingConfig,
    runtimeFlags: { verbose: boolean; quiet: boolean; dryRun?: boolean; forceDiscovery?: boolean },
  ) {
    super(name, platform, envConfig, embeddingConfig as unknown as ServiceConfig, runtimeFlags);
  }

  override getRequirements(): ServiceRequirements {
    const baseRequirements = RequirementPresets.statelessApi();

    return {
      ...baseRequirements,
      annotations: {
        ...baseRequirements.annotations,
        'service/type': SERVICE_TYPES.EMBEDDING,
        // Embedding services are always external — no start/stop lifecycle
        [COMMAND_CAPABILITY_ANNOTATIONS.START]: 'false',
        [COMMAND_CAPABILITY_ANNOTATIONS.STOP]: 'false',
        [COMMAND_CAPABILITY_ANNOTATIONS.RESTART]: 'false',
        [COMMAND_CAPABILITY_ANNOTATIONS.CONFIGURE]: 'false',
        // Voyage doesn't need provision (no model to pull)
        ...(this.embeddingConfig.type !== 'ollama' ? {
          [COMMAND_CAPABILITY_ANNOTATIONS.PROVISION]: 'false',
        } : {}),
      }
    };
  }

  getEmbeddingType(): string {
    return this.embeddingConfig.type;
  }

  getModel(): string {
    return this.embeddingConfig.model;
  }

  getBaseURL(): string {
    if (this.embeddingConfig.type === 'ollama') {
      return this.embeddingConfig.baseURL ?? 'http://localhost:11434';
    }
    return this.embeddingConfig.endpoint ?? '';
  }

  override getHealthEndpoint(): string {
    return this.embeddingConfig.type === 'ollama' ? '/api/tags' : '';
  }
}
