/**
 * Service Factory - Refactored Version
 * 
 * Creates service instances using the new platform strategy pattern.
 * Much simpler than the original factory.
 */

import { Service, ServiceName } from './service-interface.js';
import { Config, ServiceConfig } from '../lib/cli-config.js';
import { Platform } from '../lib/platform-resolver.js';
import { BackendServiceRefactored } from './backend-service.js';
import { FrontendServiceRefactored } from './frontend-service.js';
import { DatabaseServiceRefactored } from './database-service.js';
import { FilesystemServiceRefactored } from './filesystem-service.js';
import { MCPServiceRefactored } from './mcp-service.js';

export class ServiceFactory {
  /**
   * Create a service instance with platform strategy pattern
   */
  static create(
    name: ServiceName,
    platform: Platform,
    config: Config,
    serviceConfig: ServiceConfig
  ): Service {
    switch (name) {
      case 'backend':
        return new BackendServiceRefactored(name, platform, config, serviceConfig);
        
      case 'frontend':
        return new FrontendServiceRefactored(name, platform, config, serviceConfig);
        
      case 'database':
        return new DatabaseServiceRefactored(name, platform, config, serviceConfig);
        
      case 'filesystem':
        return new FilesystemServiceRefactored(name, platform, config, serviceConfig);
        
      case 'mcp':
        return new MCPServiceRefactored(name, platform, config, serviceConfig);
        
      case 'agent':
        // Agent service would be implemented similarly
        throw new Error('Agent service not yet implemented in refactored version');
        
      default:
        throw new Error(`Unknown service: ${name}`);
    }
  }
}