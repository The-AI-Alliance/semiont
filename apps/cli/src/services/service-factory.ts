/**
 * Service Factory - Refactored Version
 * 
 * Creates service instances using the new platform strategy pattern.
 * Uses GenericService for unknown service types.
 */

import { Service, ServiceName } from './service-interface.js';
import { Config, ServiceConfig } from '../lib/cli-config.js';
import { Platform } from '../lib/platform-resolver.js';
import { BackendServiceRefactored } from './backend-service.js';
import { FrontendServiceRefactored } from './frontend-service.js';
import { DatabaseServiceRefactored } from './database-service.js';
import { FilesystemServiceRefactored } from './filesystem-service.js';
import { MCPServiceRefactored } from './mcp-service.js';
import { AgentServiceRefactored } from './agent-service.js';
import { GenericService } from './generic-service.js';

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
        return new AgentServiceRefactored(name, platform, config, serviceConfig);
        
      default:
        // Use GenericService for unknown service types
        // This allows extending the system with new services without modifying the factory
        console.log(`Using GenericService for unknown service type: ${name}`);
        return new GenericService(name as any, platform, config, serviceConfig);
    }
  }
}