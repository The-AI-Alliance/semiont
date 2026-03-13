/**
 * Inference Service - Handles inference providers (Anthropic, Ollama)
 *
 * The specific provider is determined by the 'type' field in config.
 *
 * Platform Adaptations:
 * - External: Direct API calls to inference providers (no lifecycle management)
 * - Posix: Ollama runs as a local process via `ollama serve`
 * - Container: Ollama runs in Docker/Podman with persistent model volume
 */

import { BaseService } from '../core/base-service.js';
import { ServiceRequirements, RequirementPresets } from '../core/service-requirements.js';
import { COMMAND_CAPABILITY_ANNOTATIONS } from '../core/service-command-capabilities.js';
import { SERVICE_TYPES } from '../core/service-types.js';
import { type InferenceServiceConfig } from '@semiont/core';

export class InferenceService extends BaseService {

  private get typedConfig(): InferenceServiceConfig {
    return this.config as InferenceServiceConfig;
  }

  override getRequirements(): ServiceRequirements {
    const baseRequirements = RequirementPresets.statelessApi();

    return {
      ...baseRequirements,
      annotations: {
        ...baseRequirements.annotations,
        'service/type': SERVICE_TYPES.INFERENCE,
        // When on external platform, only check applies
        ...(this.platform === 'external' ? {
          [COMMAND_CAPABILITY_ANNOTATIONS.START]: 'false',
          [COMMAND_CAPABILITY_ANNOTATIONS.STOP]: 'false',
          [COMMAND_CAPABILITY_ANNOTATIONS.RESTART]: 'false',
          [COMMAND_CAPABILITY_ANNOTATIONS.PROVISION]: 'false',
          [COMMAND_CAPABILITY_ANNOTATIONS.CONFIGURE]: 'false',
        } : {}),
      }
    };
  }

  override getPort(): number {
    if (this.typedConfig.type === 'ollama') {
      return this.typedConfig.port || 11434;
    }
    return 0;
  }

  override getHealthEndpoint(): string {
    if (this.typedConfig.type === 'ollama') {
      return '/api/tags';
    }
    return '';
  }

  override getCommand(): string {
    if (this.typedConfig.type === 'ollama' && this.platform === 'posix') {
      return 'ollama serve';
    }
    return '';
  }

  override getImage(): string {
    if (this.typedConfig.type === 'ollama' && this.platform === 'container') {
      return this.typedConfig.image || 'ollama/ollama';
    }
    return '';
  }

  override getEnvironmentVariables(): Record<string, string> {
    const baseEnv = super.getEnvironmentVariables();
    const inferenceType = this.typedConfig.type;

    return {
      ...baseEnv,
      INFERENCE_TYPE: inferenceType || '',
      INFERENCE_ENDPOINT: this.typedConfig.endpoint || '',
      INFERENCE_MODEL: this.typedConfig.model || ''
    };
  }

  getInferenceType(): string {
    return this.typedConfig.type || 'unknown';
  }

  validateConfig(): void {
    const inferenceType = this.typedConfig.type;

    if (!inferenceType || !['anthropic', 'ollama'].includes(inferenceType)) {
      throw new Error(
        `Invalid or missing inference type. Must be "anthropic" or "ollama", got: ${inferenceType}`
      );
    }

    if (inferenceType === 'anthropic') {
      if (!this.typedConfig.apiKey) {
        throw new Error('API key is required for anthropic inference service');
      }
      if (!this.typedConfig.endpoint) {
        throw new Error('Endpoint URL is required for anthropic inference service');
      }
    }
  }
}
