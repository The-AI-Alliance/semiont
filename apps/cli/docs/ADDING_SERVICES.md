# Adding New Services to Semiont CLI

This guide walks you through adding a new service type to the Semiont CLI.

## Overview

Services in Semiont represent different types of application components:
- **backend** - API servers and application logic
- **frontend** - Web UI and static assets
- **database** - Data storage services
- **filesystem** - File storage services
- **mcp** - Model Context Protocol servers
- **custom** - Any other service type (uses GenericService)

Services encapsulate business logic and requirements independent of deployment platform.

## Architecture

```
Command → Service → Platform
            ↓           ↓
      Business Logic  Infrastructure
      Requirements    Implementation
      Type Declaration Handler Selection
```

## Step-by-Step Guide

### 1. Create the Service File

Create a new file in `src/services/`:

```bash
touch src/services/my-service.ts
```

### 2. Import Dependencies

```typescript
/**
 * My Service - Custom service implementation
 * 
 * Handles [describe what your service does]
 */

import { BaseService } from '../core/base-service.js';
import { 
  ServiceRequirements,
  StorageRequirement,
  NetworkRequirement,
  ResourceRequirement,
  SecurityRequirement,
  BuildRequirement,
  RequirementPresets
} from '../core/service-requirements.js';
import { SERVICE_TYPES } from '../core/service-types.js';
import { SERVICE_TYPE_ANNOTATION } from '../core/service-types.js';
import { COMMAND_CAPABILITY_ANNOTATIONS } from '../core/service-command-capabilities.js';
import { CLI_BEHAVIOR_ANNOTATIONS } from '../core/service-cli-behaviors.js';
import { ServiceName } from '../core/service-discovery.js';
import { Config, ServiceConfig } from '../core/cli-config.js';
import { PlatformType } from '../core/platform-types.js';
```

### 3. Implement the Service Class

```typescript
export class MyService extends BaseService {
  
  constructor(
    name: ServiceName,
    platform: PlatformType,
    systemConfig: Config,
    serviceConfig: ServiceConfig
  ) {
    super(name, platform, systemConfig, serviceConfig);
  }
  
  /**
   * Define the service's infrastructure requirements
   * These are used by platforms to provision appropriate resources
   */
  getRequirements(): ServiceRequirements {
    const baseRequirements = super.getRequirements();
    
    // REQUIRED: Declare service type
    const annotations = {
      // Service type declaration (required)
      [SERVICE_TYPE_ANNOTATION]: SERVICE_TYPES.BACKEND, // or FRONTEND, DATABASE, etc.
      
      // Command capability declarations (optional)
      [COMMAND_CAPABILITY_ANNOTATIONS.PUBLISH]: 'true',
      [COMMAND_CAPABILITY_ANNOTATIONS.UPDATE]: 'true',
      [COMMAND_CAPABILITY_ANNOTATIONS.BACKUP]: 'true',
      
      // CLI behavior declarations (optional)
      [CLI_BEHAVIOR_ANNOTATIONS.KEEP_ALIVE]: 'false',
      [CLI_BEHAVIOR_ANNOTATIONS.SUPPRESS_OUTPUT]: 'false',
    };
    
    // Define resource requirements
    const resources: ResourceRequirement = {
      memory: '1Gi',     // Kubernetes-style notation
      cpu: '1000m',       // 1 CPU core (1000 millicores)
      gpus: 0,
    };
    
    // Define network requirements
    const network: NetworkRequirement = {
      ports: [this.serviceConfig.port || 8080],
      protocol: 'tcp',
      needsLoadBalancer: true,
      customDomains: this.serviceConfig.domain ? [this.serviceConfig.domain] : undefined,
      healthCheckPath: '/health',
      healthCheckPort: this.serviceConfig.port || 8080,
    };
    
    // Define storage requirements
    const storage: StorageRequirement[] = [{
      persistent: true,
      size: '10Gi',
      mountPath: '/data',
      type: 'volume',
      backupEnabled: true,
    }];
    
    // Define security requirements
    const security: SecurityRequirement = {
      secrets: ['API_KEY', 'DATABASE_URL'],
      readOnlyRootFilesystem: false,
      allowPrivilegeEscalation: false,
    };
    
    // Define build requirements (if applicable)
    const build: BuildRequirement = {
      dockerfile: './Dockerfile.my-service',
      buildContext: '.',
      buildArgs: {
        NODE_VERSION: '18',
      },
      prebuilt: false,
    };
    
    return {
      ...baseRequirements,
      annotations,  // Include annotations with service type
      resources,
      network,
      storage,
      security,
      build,
      
      // Service dependencies
      dependencies: {
        services: ['database' as ServiceName],
      },
      
      // Environment variables
      environment: {
        SERVICE_NAME: this.name,
        PORT: String(this.serviceConfig.port || 8080),
        NODE_ENV: this.systemConfig.environment,
        ...this.serviceConfig.env,
      },
    };
  }
  
  /**
   * Note: Service capabilities are now declared via annotations
   * in the getRequirements() method above, not through a separate
   * getCapabilities() method. This allows platforms to understand
   * service capabilities at the requirements level.
   */
  
  /**
   * Get environment-specific configuration
   */
  getEnvironmentVariables(): Record<string, string> {
    const baseVars = super.getEnvironmentVariables();
    
    return {
      ...baseVars,
      MY_SERVICE_CONFIG: JSON.stringify(this.serviceConfig),
      FEATURE_FLAGS: this.getFeatureFlags(),
    };
  }
  
  /**
   * Validate service configuration
   */
  validateConfig(): void {
    super.validateConfig();
    
    // Add service-specific validation
    if (this.serviceConfig.requiresAuth && !this.serviceConfig.authProvider) {
      throw new Error('Auth provider must be configured when auth is required');
    }
    
    if (this.serviceConfig.port) {
      const port = Number(this.serviceConfig.port);
      if (isNaN(port) || port < 1 || port > 65535) {
        throw new Error('Invalid port number');
      }
    }
  }
  
  /**
   * Get the start command for this service
   * Used by process and container platforms
   */
  getStartCommand(): string {
    // Return the command to start your service
    const script = this.serviceConfig.script || 'start';
    return `npm run ${script}`;
  }
  
  /**
   * Get the Docker image for this service
   * Used by container and AWS platforms
   */
  getDockerImage(): string {
    // Return the Docker image name
    const registry = this.serviceConfig.registry || 'docker.io';
    const image = this.serviceConfig.image || `my-org/my-service`;
    const tag = this.serviceConfig.tag || 'latest';
    
    return `${registry}/${image}:${tag}`;
  }
  
  /**
   * Get health check configuration
   */
  getHealthCheck(): {
    enabled: boolean;
    endpoint?: string;
    interval?: number;
    timeout?: number;
  } {
    return {
      enabled: true,
      endpoint: '/health',
      interval: 30,
      timeout: 5,
    };
  }
  
  /**
   * Get backup configuration
   */
  getBackupConfig(): {
    enabled: boolean;
    schedule?: string;
    retention?: number;
    paths?: string[];
  } {
    return {
      enabled: true,
      schedule: '0 2 * * *',  // Daily at 2 AM
      retention: 7,            // Keep 7 days of backups
      paths: [
        '/data',
        '/config',
      ],
    };
  }
  
  /**
   * Get test configuration
   */
  getTestConfig(): {
    suites: Record<string, string>;
    coverage: boolean;
    timeout: number;
  } {
    return {
      suites: {
        unit: 'npm run test:unit',
        integration: 'npm run test:integration',
        e2e: 'npm run test:e2e',
      },
      coverage: true,
      timeout: 300,  // 5 minutes
    };
  }
  
  /**
   * Service-specific helper methods
   */
  
  private getFeatureFlags(): string {
    // Return feature flags based on environment
    const flags: Record<string, boolean> = {
      newFeature: this.config.environment !== 'prod',
      debugMode: this.config.verbose,
      analytics: this.config.environment === 'prod',
    };
    
    return JSON.stringify(flags);
  }
  
  /**
   * Hook called before service starts
   */
  async beforeStart(): Promise<void> {
    // Perform any pre-start setup
    console.log(`Preparing ${this.name} for startup...`);
    
    // Validate dependencies are running
    const deps = this.getRequirements().dependencies?.services || [];
    for (const dep of deps) {
      // Check if dependency is available
      // This is handled by the platform, but you can add extra checks
    }
  }
  
  /**
   * Hook called after service starts
   */
  async afterStart(): Promise<void> {
    // Perform any post-start setup
    console.log(`${this.name} started successfully`);
    
    // Register with service discovery, send metrics, etc.
  }
  
  /**
   * Hook called before service stops
   */
  async beforeStop(): Promise<void> {
    // Perform graceful shutdown tasks
    console.log(`Preparing ${this.name} for shutdown...`);
    
    // Close connections, save state, etc.
  }
  
  /**
   * Hook called after service stops
   */
  async afterStop(): Promise<void> {
    // Perform cleanup
    console.log(`${this.name} stopped successfully`);
    
    // Deregister from service discovery, etc.
  }
}
```

### 4. Register the Service

Add your service to the factory in `src/services/service-factory.ts`:

```typescript
import { MyService } from './my-service.js';

export class ServiceFactory {
  static create(
    name: ServiceName,
    platform: PlatformType,
    systemConfig: Config,
    serviceConfig: ServiceConfig
  ): Service {
    switch (name) {
      case 'backend':
        return new BackendService(name, platform, systemConfig, serviceConfig);
      case 'frontend':
        return new FrontendService(name, platform, systemConfig, serviceConfig);
      case 'graph':
        // Note: Some services might have a fixed name
        return new GraphService('graph', platform, systemConfig, serviceConfig);
      case 'my-service':
        return new MyService(name, platform, systemConfig, serviceConfig);
      default:
        // GenericService handles unknown types
        // IMPORTANT: Avoid using GenericService for known service types
        return new GenericService(name as any, platform, systemConfig, serviceConfig);
    }
  }
}
```

### 5. Important: Service Type Declaration

Every service MUST declare its type via the `service/type` annotation. This is how platforms determine which handlers to use:

```typescript
const annotations = {
  [SERVICE_TYPE_ANNOTATION]: SERVICE_TYPES.BACKEND,  // Required!
  // ... other annotations
};
```

Available service types:
- `SERVICE_TYPES.FRONTEND` - User-facing web applications
- `SERVICE_TYPES.BACKEND` - API servers and application logic
- `SERVICE_TYPES.DATABASE` - Data persistence layers
- `SERVICE_TYPES.FILESYSTEM` - File storage services
- `SERVICE_TYPES.WORKER` - Background job processors
- `SERVICE_TYPES.MCP` - Model Context Protocol services
- `SERVICE_TYPES.INFERENCE` - AI/ML model serving
- `SERVICE_TYPES.GENERIC` - General-purpose services

### 6. Configure Implementation Types

For services that support multiple implementations (like graph databases), ensure your configuration includes the implementation type:

```json
// environments/local.json
{
  "services": {
    "graph": {
      "platform": { "type": "container" },
      "type": "janusgraph",  // CRITICAL: Implementation type
      "port": 8182,
      "storage": "berkeleydb"
    }
  }
}
```

Your handlers should check this implementation type:

```typescript
const implementationType = service.config.type;

if (implementationType !== 'expected-type') {
  return {
    success: false,
    error: `Unsupported implementation: ${implementationType}`
  };
}
```

**Important**: Never use fallbacks when reading implementation types. This ensures explicit configuration and clear error messages.

### 7. Update Service Registry

Add your service to the ServiceName type in `src/core/service-discovery.ts`:

```typescript
export type ServiceName = 
  | 'backend' 
  | 'frontend' 
  | 'database' 
  | 'filesystem' 
  | 'mcp'
  | 'my-service';
```

### 6. Add Tests

Create test file at `src/services/__tests__/my-service.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { MyService } from '../my-service.js';
import { Config } from '../../lib/cli-config.js';

describe('MyService', () => {
  let service: MyService;
  let config: Config;
  
  beforeEach(() => {
    config = {
      projectRoot: '/test',
      environment: 'test',
      verbose: false,
      quiet: false,
    };
    
    service = new MyService(
      'my-service',
      'process',
      config,
      { port: 8080 }
    );
  });
  
  describe('getRequirements', () => {
    it('should define compute requirements', () => {
      const requirements = service.getRequirements();
      
      expect(requirements.compute).toEqual({
        memory: 1024,
        cpu: 1.0,
        gpu: false,
      });
    });
    
    it('should define network requirements', () => {
      const requirements = service.getRequirements();
      
      expect(requirements.network?.ports).toContainEqual({
        port: 8080,
        protocol: 'tcp',
        public: true,
      });
    });
    
    it('should include dependencies', () => {
      const requirements = service.getRequirements();
      
      expect(requirements.dependencies).toContain('database');
    });
  });
  
  describe('getCapabilities', () => {
    it('should support expected capabilities', () => {
      const capabilities = service.getCapabilities();
      
      expect(capabilities).toContain('start');
      expect(capabilities).toContain('stop');
      expect(capabilities).toContain('backup');
    });
  });
  
  describe('validateConfig', () => {
    it('should validate port numbers', () => {
      const invalidService = new MyService(
        'my-service',
        'process',
        config,
        { port: 99999 }
      );
      
      expect(() => invalidService.validateConfig()).toThrow('Invalid port');
    });
  });
});
```

## Service Requirements

Services declare requirements that platforms use to provision resources:

### Compute Requirements
```typescript
compute: {
  memory: 512,     // Memory in MB
  cpu: 0.5,        // CPU units (0.5 = half vCPU)
  gpu: false,      // GPU required
  spot: true,      // Can use spot/preemptible instances
}
```

### Network Requirements
```typescript
network: {
  ports: [
    { port: 3000, protocol: 'tcp', public: true },
    { port: 9090, protocol: 'tcp', public: false }  // Internal only
  ],
  domains: ['api.example.com'],
  loadBalancer: true,
  healthCheck: {
    path: '/health',
    interval: 30,
    timeout: 5,
    retries: 3,
  }
}
```

### Storage Requirements
```typescript
storage: {
  persistent: 10240,   // Persistent storage in MB
  ephemeral: 5120,     // Temporary storage in MB
  mountPath: '/data',  // Where to mount persistent storage
  backupEnabled: true,
  encryption: true,
}
```

### Security Requirements
```typescript
security: {
  secrets: ['API_KEY', 'DATABASE_URL'],  // Required secrets
  certificates: ['ssl-cert'],            // Required certificates
  iamRole: 'service-role',              // IAM role name
  allowedOrigins: ['https://example.com'],
}
```

### Build Requirements
```typescript
build: {
  dockerfile: './Dockerfile',
  context: '.',
  args: { VERSION: '1.0.0' },
  target: 'production',
  cache: true,
}
```

## Service Capabilities

Services declare their capabilities to inform commands what operations they support:

```typescript
type ServiceCapability = 
  | 'start'     // Can be started
  | 'stop'      // Can be stopped
  | 'restart'   // Can be restarted
  | 'check'     // Supports health checks
  | 'backup'    // Supports backups
  | 'restore'   // Supports restoration
  | 'publish'   // Can be published/deployed
  | 'update'    // Supports updates
  | 'provision' // Requires provisioning
  | 'test'      // Has tests
  | 'exec'      // Supports command execution
  | 'logs';     // Provides logs
```

Commands check capabilities before attempting operations:

```typescript
if (!service.getCapabilities().includes('backup')) {
  return {
    success: false,
    error: 'Service does not support backups'
  };
}
```

## Service Lifecycle Hooks

Services can implement lifecycle hooks:

```typescript
class MyService extends BaseService {
  async beforeStart(): Promise<void> {
    // Pre-start validation, setup
  }
  
  async afterStart(): Promise<void> {
    // Post-start registration, warming
  }
  
  async beforeStop(): Promise<void> {
    // Graceful shutdown preparation
  }
  
  async afterStop(): Promise<void> {
    // Cleanup, deregistration
  }
  
  async beforeBackup(): Promise<void> {
    // Prepare for backup (flush caches, etc.)
  }
  
  async afterRestore(): Promise<void> {
    // Post-restore validation, reindexing
  }
}
```

## Configuration Sources

Services can get configuration from multiple sources:

```typescript
class MyService extends BaseService {
  getConfig() {
    return {
      // From service-specific config
      ...this.serviceConfig,
      
      // From environment config
      ...this.getEnvironmentConfig(),
      
      // From secrets (platform-specific)
      ...this.getSecrets(),
      
      // Defaults
      ...this.getDefaults(),
    };
  }
}
```

## Best Practices

### 1. Keep Services Platform-Agnostic

Services should not contain platform-specific code:

```typescript
// ✅ Good - Service declares requirements
getRequirements() {
  return { compute: { memory: 512 } };
}

// ❌ Bad - Service contains AWS-specific code
startOnAWS() {
  const ecs = new ECSClient();
  // ...
}
```

### 2. Use Requirements for Resource Needs

Let platforms interpret requirements:

```typescript
// ✅ Good - Declare what you need
getRequirements() {
  return {
    compute: { memory: 1024, cpu: 1 },
    network: { ports: [{ port: 3000 }] }
  };
}

// ❌ Bad - Specify how to provision
getDockerConfig() {
  return {
    memory: '1024m',
    cpus: '1.0',
    ports: ['3000:3000']
  };
}
```

### 3. Validate Configuration

Validate configuration in the service:

```typescript
validateConfig() {
  if (!this.serviceConfig.apiKey) {
    throw new Error('API key is required');
  }
  
  if (this.serviceConfig.timeout < 0) {
    throw new Error('Timeout must be positive');
  }
}
```

### 4. Use Capabilities Correctly

Only declare capabilities you actually support:

```typescript
getCapabilities() {
  // Only include what's implemented
  const capabilities: ServiceCapability[] = ['start', 'stop', 'check'];
  
  // Add conditional capabilities
  if (this.hasTests()) {
    capabilities.push('test');
  }
  
  if (this.supportsBackup()) {
    capabilities.push('backup', 'restore');
  }
  
  return capabilities;
}
```

### 5. Handle Dependencies

Declare dependencies in requirements:

```typescript
getRequirements() {
  return {
    dependencies: ['database', 'cache'],
    // Platform will ensure these are running first
  };
}
```

## Testing Your Service

1. **Unit tests** - Test requirements, capabilities, configuration
2. **Integration tests** - Test with different platforms
3. **Lifecycle tests** - Test hooks are called correctly
4. **Configuration tests** - Test various configurations
5. **Validation tests** - Test config validation

## Checklist

- [ ] Service class extends BaseService
- [ ] getRequirements() returns appropriate requirements
- [ ] getCapabilities() returns supported operations
- [ ] validateConfig() validates configuration
- [ ] Service registered in ServiceFactory
- [ ] ServiceName type updated
- [ ] Tests cover main functionality
- [ ] Lifecycle hooks implemented (if needed)
- [ ] Documentation updated

## Examples

Look at existing services for examples:
- `backend-service.ts` - API server with health checks
- `frontend-service.ts` - Static web service
- `database-service.ts` - Stateful service with backups
- `filesystem-service.ts` - Storage service
- `mcp-service.ts` - Model Context Protocol server
- `generic-service.ts` - Fallback for unknown services