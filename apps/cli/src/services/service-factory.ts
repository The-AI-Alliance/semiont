/**
 * Service Factory - Refactored Version
 * 
 * Creates service instances using the new platform strategy pattern.
 * Uses GenericService for unknown service types.
 */

import { Service } from '../core/service-interface.js';
import { ServiceName } from '../core/service-discovery.js';
import { Config, ServiceConfig } from '../core/cli-config.js';
import { PlatformType } from '../core/platform-types.js';
import { BackendService } from './backend-service.js';
import { FrontendService } from './frontend-service.js';
import { DatabaseService } from './database-service.js';
import { FilesystemService } from './filesystem-service.js';
import { GraphService } from './graph-service.js';
import { MCPService } from './mcp-service.js';
import { InferenceService } from './inference-service.js';
import { GenericService } from '../core/generic-service.js';
import { printInfo } from '../core/io/cli-logger.js';

export class ServiceFactory {
  /**
   * Create a service instance with platform strategy pattern
   */
  static create(
    name: ServiceName,
    platform: PlatformType,
    config: Config,
    serviceConfig: ServiceConfig
  ): Service {
    switch (name) {
      case 'backend':
        return new BackendService(name, platform, config, serviceConfig);
        
      case 'frontend':
        return new FrontendService(name, platform, config, serviceConfig);
        
      case 'database':
        return new DatabaseService(name, platform, config, serviceConfig);
        
      case 'filesystem':
        return new FilesystemService(name, platform, config, serviceConfig);
        
      case 'graph':
        return new GraphService('graph', platform, config, serviceConfig);
        
      case 'mcp':
        return new MCPService(name, platform, config, serviceConfig);
        
      case 'inference':
        return new InferenceService(name, platform, config, serviceConfig);
        
      default:
        // Use GenericService for unknown service types
        // This allows extending the system with new services without modifying the factory
        printInfo(`Using GenericService for unknown service type: ${name}`);
        return new GenericService(name as any, platform, config, serviceConfig);
    }
  }
}