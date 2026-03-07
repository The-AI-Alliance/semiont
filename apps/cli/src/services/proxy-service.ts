/**
 * Proxy Service Implementation
 *
 * Handles proxy services (Envoy, nginx, haproxy) for routing traffic
 * between frontend and backend services.
 */

import { BaseService } from '../core/base-service.js';
import { ServiceRequirements, RequirementPresets } from '../core/service-requirements.js';
import { SERVICE_TYPES, SERVICE_TYPE_ANNOTATION } from '../core/service-types.js';
import { COMMAND_CAPABILITY_ANNOTATIONS } from '../core/service-command-capabilities.js';
import type { ProxyServiceConfig } from '@semiont/core';

export class ProxyService extends BaseService {
  // Type-narrowed config accessor
  private get typedConfig(): ProxyServiceConfig {
    return this.config as ProxyServiceConfig;
  }

  override getRequirements(): ServiceRequirements {
    // Start with stateless API requirements
    const baseRequirements = RequirementPresets.statelessApi();

    // Proxy services need ports for main proxy and admin interface
    const proxyRequirements: ServiceRequirements = {
      network: {
        ports: [
          this.typedConfig.port || 8080,
          this.typedConfig.adminPort || 9901
        ],
        protocol: 'tcp',
        healthCheckPort: this.typedConfig.port || 8080
      },
      annotations: {
        // Declare service type
        [SERVICE_TYPE_ANNOTATION]: SERVICE_TYPES.PROXY,
        // Declare supported commands
        [COMMAND_CAPABILITY_ANNOTATIONS.PROVISION]: 'true',
        [COMMAND_CAPABILITY_ANNOTATIONS.START]: 'true',
        [COMMAND_CAPABILITY_ANNOTATIONS.STOP]: 'true',
        [COMMAND_CAPABILITY_ANNOTATIONS.CHECK]: 'true',
      }
    };

    // Merge base and proxy-specific requirements
    return {
      ...baseRequirements,
      ...proxyRequirements
    };
  }
}