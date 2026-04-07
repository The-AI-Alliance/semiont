/**
 * Vectors Service - Handles vector database lifecycle (Qdrant, etc.)
 *
 * Manages the vector database used for semantic search.
 * Reads config from environments.<env>.services.vectors.
 *
 * Platform Adaptations:
 * - external: Health check only (Qdrant managed outside the CLI)
 * - container: Start/stop Qdrant container (future)
 * - posix: Start/stop local Qdrant process (future)
 */

import { BaseService } from '../core/base-service.js';
import { ServiceRequirements, RequirementPresets } from '../core/service-requirements.js';
import { COMMAND_CAPABILITY_ANNOTATIONS } from '../core/service-command-capabilities.js';
import { SERVICE_TYPES } from '../core/service-types.js';
import type { VectorsServiceConfig, EnvironmentConfig } from '@semiont/core';
import type { ServiceName } from '../core/service-discovery.js';
import type { PlatformType } from '@semiont/core';
import type { ServiceConfig } from '../core/cli-config.js';

export class VectorsService extends BaseService {
  constructor(
    name: ServiceName,
    platform: PlatformType,
    envConfig: EnvironmentConfig,
    serviceConfig: VectorsServiceConfig,
    runtimeFlags: { verbose: boolean; quiet: boolean; dryRun?: boolean; forceDiscovery?: boolean },
  ) {
    super(name, platform, envConfig, serviceConfig as unknown as ServiceConfig, runtimeFlags);
  }

  override getRequirements(): ServiceRequirements {
    const baseRequirements = RequirementPresets.statelessApi();

    return {
      ...baseRequirements,
      annotations: {
        ...baseRequirements.annotations,
        'service/type': SERVICE_TYPES.VECTORS,
        // For now, vectors is external-only (no start/stop/provision handlers yet)
        ...(this.platform === 'external' ? {
          [COMMAND_CAPABILITY_ANNOTATIONS.START]: 'false',
          [COMMAND_CAPABILITY_ANNOTATIONS.STOP]: 'false',
          [COMMAND_CAPABILITY_ANNOTATIONS.RESTART]: 'false',
          [COMMAND_CAPABILITY_ANNOTATIONS.CONFIGURE]: 'false',
          [COMMAND_CAPABILITY_ANNOTATIONS.PROVISION]: 'false',
        } : {}),
      }
    };
  }

  override getPort(): number {
    return (this.config as unknown as VectorsServiceConfig).port ?? 6333;
  }

  override getHealthEndpoint(): string {
    return '/healthz';
  }

  getVectorsType(): string {
    return (this.config as unknown as VectorsServiceConfig).type;
  }

  getHost(): string {
    return (this.config as unknown as VectorsServiceConfig).host ?? 'localhost';
  }
}
