import { Service, ServiceName, DeploymentType, Config, ServiceConfig } from './types.js';
import { BackendService } from './backend-service.js';
import { FrontendService } from './frontend-service.js';
import { DatabaseService } from './database-service.js';
import { FilesystemService } from './filesystem-service.js';
import { MCPService } from './mcp-service.js';

export class ServiceFactory {
  static create(
    serviceName: ServiceName,
    deploymentType: DeploymentType,
    config: Config,
    serviceConfig: ServiceConfig
  ): Service {
    // Ensure service config has deployment type
    serviceConfig.deploymentType = deploymentType;
    
    switch (serviceName) {
      case 'backend':
        return new BackendService(serviceName, deploymentType, config, serviceConfig);
        
      case 'frontend':
        return new FrontendService(serviceName, deploymentType, config, serviceConfig);
        
      case 'database':
        return new DatabaseService(serviceName, deploymentType, config, serviceConfig);
        
      case 'filesystem':
        return new FilesystemService(serviceName, deploymentType, config, serviceConfig);
        
      case 'mcp':
        return new MCPService(serviceName, deploymentType, config, serviceConfig);
        
      case 'agent':
        // Agent service not implemented yet
        throw new Error(`Service ${serviceName} not implemented yet`);
        
      default:
        throw new Error(`Unknown service: ${serviceName}`);
    }
  }
}