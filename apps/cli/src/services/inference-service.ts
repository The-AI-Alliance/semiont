/**
 * Inference Service - Handles inference providers (Anthropic, Ollama)
 *
 * One InferenceService instance is created per configured inference provider
 * (e.g. one for 'ollama', one for 'anthropic'). The inferenceType is the key
 * from environments.<env>.inference.<type> in ~/.semiontconfig.
 *
 * Platform Adaptations:
 * - external: Direct API calls to inference providers (no lifecycle management)
 * - posix: Ollama runs as a local process via `ollama serve`
 * - container: Ollama runs in a container with persistent model volume
 */

import { BaseService } from '../core/base-service.js';
import { ServiceRequirements, RequirementPresets } from '../core/service-requirements.js';
import { COMMAND_CAPABILITY_ANNOTATIONS } from '../core/service-command-capabilities.js';
import { SERVICE_TYPES } from '../core/service-types.js';
import type { OllamaProviderConfig, AnthropicProviderConfig, EnvironmentConfig } from '@semiont/core';
import type { ServiceName } from '../core/service-discovery.js';
import type { PlatformType } from '@semiont/core';
import type { ServiceConfig } from '../core/cli-config.js';

type InferenceProviderConfig = OllamaProviderConfig | AnthropicProviderConfig;

export class InferenceService extends BaseService {
  constructor(
    name: ServiceName,
    platform: PlatformType,
    envConfig: EnvironmentConfig,
    serviceConfig: InferenceProviderConfig,
    runtimeFlags: { verbose: boolean; quiet: boolean; dryRun?: boolean; forceDiscovery?: boolean },
    private readonly inferenceType: string,
  ) {
    super(name, platform, envConfig, serviceConfig as ServiceConfig, runtimeFlags);
  }

  override getRequirements(): ServiceRequirements {
    const baseRequirements = RequirementPresets.statelessApi();

    return {
      ...baseRequirements,
      annotations: {
        ...baseRequirements.annotations,
        'service/type': SERVICE_TYPES.INFERENCE,
        ...(this.platform === 'external' ? {
          [COMMAND_CAPABILITY_ANNOTATIONS.START]: 'false',
          [COMMAND_CAPABILITY_ANNOTATIONS.STOP]: 'false',
          [COMMAND_CAPABILITY_ANNOTATIONS.RESTART]: 'false',
          [COMMAND_CAPABILITY_ANNOTATIONS.CONFIGURE]: 'false',
          // Ollama supports provision (model pulling) even when external — only Anthropic doesn't
          ...(this.inferenceType !== 'ollama' ? {
            [COMMAND_CAPABILITY_ANNOTATIONS.PROVISION]: 'false',
          } : {}),
        } : {}),
      }
    };
  }

  override getPort(): number {
    if (this.inferenceType === 'ollama') {
      return (this.config as OllamaProviderConfig).port ?? 11434;
    }
    return 0;
  }

  override getHealthEndpoint(): string {
    return this.inferenceType === 'ollama' ? '/api/tags' : '';
  }

  override getCommand(): string {
    return (this.inferenceType === 'ollama' && this.platform === 'posix')
      ? 'ollama serve' : '';
  }

  override getImage(): string {
    return (this.inferenceType === 'ollama' && this.platform === 'container')
      ? ((this.config as OllamaProviderConfig).image ?? 'ollama/ollama') : '';
  }

  getInferenceType(): string {
    return this.inferenceType;
  }

  /**
   * Returns the union of all models referenced by workers, actors,
   * and vector embeddings configured to use this inference provider type.
   */
  getModels(): string[] {
    const models = new Set<string>();
    for (const w of Object.values(this.envConfig.workers ?? {})) {
      if (w.inference?.type === this.inferenceType && w.inference.model) {
        models.add(w.inference.model);
      }
    }
    for (const a of Object.values(this.envConfig.actors ?? {})) {
      if (a.inference?.type === this.inferenceType && a.inference.model) {
        models.add(a.inference.model);
      }
    }
    const embedding = this.envConfig.services.vectors?.embedding;
    if (embedding?.type === this.inferenceType && embedding.model) {
      models.add(embedding.model);
    }
    return [...models];
  }

  validateConfig(): void {
    if (this.inferenceType === 'anthropic') {
      const c = this.config as unknown as AnthropicProviderConfig;
      if (!c.apiKey) {
        throw new Error('apiKey is required for anthropic inference provider');
      }
      if (!c.endpoint) {
        throw new Error('endpoint is required for anthropic inference provider');
      }
    }
  }
}
