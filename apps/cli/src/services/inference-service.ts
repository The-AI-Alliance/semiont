/**
 * Inference Service - Handles both Claude and OpenAI inference providers
 * 
 * This service represents external AI inference APIs that cannot be started/stopped.
 * The specific provider (Claude or OpenAI) is determined by the 'type' field in config.
 * 
 * Default Requirements:
 * - External API service (no local resources)
 * - API key authentication required
 * - Network access for API calls
 * 
 * Platform Adaptations:
 * - External: Direct API calls to inference providers
 * - Other platforms: Not supported (external only)
 */

import { BaseService } from '../core/base-service.js';
import { ServiceRequirements, RequirementPresets } from '../core/service-requirements.js';
import { COMMAND_CAPABILITY_ANNOTATIONS } from '../core/service-command-capabilities.js';
import { SERVICE_TYPES } from '../core/service-types.js';
import { type InferenceServiceConfig } from '@semiont/core';

export class InferenceService extends BaseService {

  // Type-narrowed config accessor
  private get typedConfig(): InferenceServiceConfig {
    return this.config as InferenceServiceConfig;
  }
  
  // =====================================================================
  // Service Requirements
  // =====================================================================
  
  override getRequirements(): ServiceRequirements {
    // Inference services are external APIs - no local resources needed
    const baseRequirements = RequirementPresets.statelessApi();
    
    return {
      ...baseRequirements,
      annotations: {
        ...baseRequirements.annotations,
        'service/type': SERVICE_TYPES.INFERENCE,
        // External services only support check and watch
        [COMMAND_CAPABILITY_ANNOTATIONS.START]: 'false',
        [COMMAND_CAPABILITY_ANNOTATIONS.STOP]: 'false',
        [COMMAND_CAPABILITY_ANNOTATIONS.RESTART]: 'false',
        [COMMAND_CAPABILITY_ANNOTATIONS.PROVISION]: 'false',
        [COMMAND_CAPABILITY_ANNOTATIONS.CONFIGURE]: 'false',
      }
    };
  }
  
  // =====================================================================
  // Service-specific configuration
  // =====================================================================
  
  override getPort(): number {
    return 0; // External API, no local port
  }
  
  override getHealthEndpoint(): string {
    return ''; // Health checks done via API calls
  }
  
  override getCommand(): string {
    return ''; // External service, no local command
  }
  
  override getImage(): string {
    return ''; // External service, no container image
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
  
  /**
   * Get inference provider type from config
   */
  getInferenceType(): string {
    return this.typedConfig.type || 'unknown';
  }
  
  /**
   * Validate inference service configuration
   */
  validateConfig(): void {
    const inferenceType = this.typedConfig.type;

    if (!inferenceType || !['anthropic', 'openai'].includes(inferenceType)) {
      throw new Error(
        `Invalid or missing inference type. Must be "anthropic" or "openai", got: ${inferenceType}`
      );
    }

    // Check for API key
    if (!this.typedConfig.apiKey) {
      throw new Error(`API key is required for ${inferenceType} inference service`);
    }

    // Check for endpoint
    if (!this.typedConfig.endpoint) {
      throw new Error(`Endpoint URL is required for ${inferenceType} inference service`);
    }

    // Provider-specific validation
    if (inferenceType === 'openai' && !this.typedConfig.organization) {
      console.warn('OpenAI organization ID may be required for some API keys');
    }
  }
}