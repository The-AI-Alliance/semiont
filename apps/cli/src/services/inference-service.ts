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
import { SERVICE_TYPES } from '../core/service-types.js';

export class InferenceService extends BaseService {
  
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
        // Service type declaration
        'service/type': SERVICE_TYPES.INFERENCE,
        // External services can only be checked, not started/stopped
        'command/check': 'true',
        // Inference services are external, no lifecycle management
        'platform/external-only': 'true'
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
    const inferenceType = this.config.type;
    
    return {
      ...baseEnv,
      INFERENCE_TYPE: inferenceType || '',
      INFERENCE_ENDPOINT: this.config.endpoint || '',
      INFERENCE_MODEL: this.config.model || ''
    };
  }
  
  /**
   * Get inference provider type from config
   */
  getInferenceType(): string {
    return this.config.type || 'unknown';
  }
  
  /**
   * Validate inference service configuration
   */
  validateConfig(): void {
    const inferenceType = this.config.type;
    
    if (!inferenceType || !['claude', 'openai'].includes(inferenceType)) {
      throw new Error(
        `Invalid or missing inference type. Must be "claude" or "openai", got: ${inferenceType}`
      );
    }

    // Check for API key
    if (!this.config.apiKey) {
      throw new Error(`API key is required for ${inferenceType} inference service`);
    }

    // Check for endpoint
    if (!this.config.endpoint) {
      throw new Error(`Endpoint URL is required for ${inferenceType} inference service`);
    }

    // Provider-specific validation
    if (inferenceType === 'openai' && !this.config.organization) {
      console.warn('OpenAI organization ID may be required for some API keys');
    }
  }
}