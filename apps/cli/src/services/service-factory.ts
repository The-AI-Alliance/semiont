/**
 * Service Factory - Refactored Version
 * 
 * Creates service instances using the new platform strategy pattern.
 * Uses GenericService for unknown service types.
 */

import { Service, ServiceName } from './service-interface.js';
import { Config, ServiceConfig } from '../lib/cli-config.js';
import { Platform } from '../lib/platform-resolver.js';
import { BackendService } from './backend-service.js';
import { FrontendService } from './frontend-service.js';
import { DatabaseService } from './database-service.js';
import { FilesystemService } from './filesystem-service.js';
import { MCPService } from './mcp-service.js';
import { AgentService } from './agent-service.js';
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
        return new BackendService(name, platform, config, serviceConfig);
        
      case 'frontend':
        return new FrontendService(name, platform, config, serviceConfig);
        
      case 'database':
        return new DatabaseService(name, platform, config, serviceConfig);
        
      case 'filesystem':
        return new FilesystemService(name, platform, config, serviceConfig);
        
      case 'mcp':
        return new MCPService(name, platform, config, serviceConfig);
        
      case 'agent':
        return new AgentService(name, platform, config, serviceConfig);
        
      default:
        // Use GenericService for unknown service types
        // This allows extending the system with new services without modifying the factory
        console.log(`Using GenericService for unknown service type: ${name}`);
        return new GenericService(name as any, platform, config, serviceConfig);
    }
  }
}