# Semiont CLI Architecture

## Overview

The Semiont CLI follows a layered architecture that separates concerns and enables extensibility:

```
┌─────────────────────────────────────────────┐
│                  Commands                   │  User-facing operations
├─────────────────────────────────────────────┤
│                  Services                   │  Business logic & requirements
├─────────────────────────────────────────────┤
│                 Platforms                   │  Infrastructure implementations
├─────────────────────────────────────────────┤
│                 Libraries                   │  Shared utilities
└─────────────────────────────────────────────┘
```

## Core Concepts

### 1. Commands
**Location:** `src/commands/`  
**Purpose:** Define CLI operations that users can execute  
**Pattern:** Commands orchestrate services and handle user interaction

Commands are responsible for:
- Parsing and validating user input
- Resolving service deployments
- Orchestrating operations across services
- Formatting and presenting results

Example flow:
```typescript
start command → resolve services → create service instances → delegate to platform → return results
```

### 2. Services  
**Location:** `src/services/`  
**Purpose:** Encapsulate business logic and declare requirements  
**Pattern:** Services are platform-agnostic and focus on "what" not "how"

Services define:
- Infrastructure requirements (compute, network, storage)
- Supported capabilities (start, stop, backup, etc.)
- Configuration validation
- Environment variables
- Lifecycle hooks

Example:
```typescript
class BackendService extends BaseService {
  getRequirements() {
    return {
      compute: { memory: 512, cpu: 1 },
      network: { ports: [{ port: 3000 }] }
    };
  }
}
```

### 3. Platforms
**Location:** `src/platforms/`  
**Purpose:** Implement infrastructure-specific operations  
**Pattern:** Platforms interpret service requirements and manage resources

Platforms handle:
- Resource provisioning based on requirements
- Service lifecycle management (start, stop, update)
- Platform-specific operations (backups, logs, exec)
- State management and resource tracking

Example:
```typescript
class ContainerPlatform implements PlatformStrategy {
  async start(context: ServiceContext) {
    // Use Docker/Podman to start container
    // Based on service requirements
  }
}
```

### 4. Libraries
**Location:** `src/lib/`  
**Purpose:** Shared utilities used across the system  
**Categories:**
- **CLI utilities:** colors, logger, paths
- **Validation:** validators, environment-validator
- **Configuration:** cli-config, types
- **Networking:** network-utils
- **String manipulation:** string-utils

## Key Design Patterns

### Strategy Pattern (Platforms)
Each platform implements the `PlatformStrategy` interface, allowing services to work with any infrastructure:

```typescript
interface PlatformStrategy {
  start(context: ServiceContext): Promise<StartResult>;
  stop(context: ServiceContext): Promise<StopResult>;
  // ... other operations
}
```

### Factory Pattern (Services & Platforms)
Factories create appropriate instances based on configuration:

```typescript
ServiceFactory.create(name, platform, config)
PlatformFactory.getPlatform(type)
```

### Command Builder Pattern
Commands use a fluent builder for consistent definitions:

```typescript
new CommandBuilder()
  .name('start')
  .description('Start services')
  .schema(StartOptionsSchema)
  .requiresServices(true)
  .handler(startCommand)
  .build()
```

### Requirements Pattern
Services declare requirements; platforms fulfill them:

```typescript
Service: "I need 512MB RAM and port 3000"
Platform: "I'll provide that using [platform-specific method]"
```

#### How Services Declare Requirements

Services declare their infrastructure needs through the `getRequirements()` method:

```typescript
class BackendService extends BaseService {
  getRequirements(): ServiceRequirements {
    return {
      compute: { 
        memory: 512,    // MB of RAM needed
        cpu: 1.0        // CPU cores needed
      },
      network: { 
        ports: [{ port: 3000, protocol: 'tcp', public: true }] 
      },
      storage: { 
        persistent: 1024,  // MB of persistent storage
        ephemeral: 512     // MB of temporary storage
      },
      dependencies: ['database', 'cache'],  // Other services needed
      environment: {                        // Environment variables
        NODE_ENV: 'production',
        API_KEY: process.env.API_KEY
      }
    };
  }
}
```

#### How Platforms Fulfill Requirements

Platforms interpret these requirements and provision resources accordingly:

```typescript
class ContainerPlatform implements PlatformStrategy {
  async start(context: ServiceContext): Promise<StartResult> {
    const requirements = context.service.getRequirements();
    
    // Translate requirements into Docker configuration
    const dockerConfig = {
      Image: context.service.getDockerImage(),
      HostConfig: {
        Memory: requirements.compute.memory * 1024 * 1024, // Convert MB to bytes
        CpuShares: requirements.compute.cpu * 1024,
        PortBindings: this.mapPorts(requirements.network.ports)
      },
      Env: this.formatEnvironment(requirements.environment)
    };
    
    // Start container with translated configuration
    const container = await docker.createContainer(dockerConfig);
    await container.start();
  }
}

class ProcessPlatform implements PlatformStrategy {
  async start(context: ServiceContext): Promise<StartResult> {
    const requirements = context.service.getRequirements();
    
    // For processes, requirements guide resource limits
    const processOptions = {
      env: requirements.environment,
      // Process platform may use ulimit or cgroups for memory/CPU limits
      maxMemory: requirements.compute.memory,
      port: requirements.network.ports[0]?.port
    };
    
    // Start process with configuration
    const child = spawn(context.service.getStartCommand(), processOptions);
  }
}
```

#### Benefits of This Separation

1. **Platform Independence**: Services don't need to know whether they'll run as processes, containers, or cloud services. They just declare what they need.

2. **Reusability**: The same service definition works across all platforms without modification:
   ```typescript
   // Same service works everywhere
   const backend = new BackendService();
   await processPlatform.start(backend);    // Runs as local process
   await containerPlatform.start(backend);  // Runs as Docker container
   await awsPlatform.start(backend);        // Runs on AWS ECS/Fargate
   ```

3. **Testability**: Services can be tested with mock platforms without requiring actual infrastructure:
   ```typescript
   const mockPlatform = new MockPlatform();
   await mockPlatform.start(service);  // No actual resources provisioned
   ```

4. **Maintainability**: Changes to infrastructure don't affect business logic:
   - Upgrade Docker? Only update `ContainerPlatform`
   - Switch from ECS to EKS? Only update `AwsPlatform`
   - Add Kubernetes support? Create new `K8sPlatform`

5. **Configuration Flexibility**: Platforms can optimize resource allocation based on their capabilities:
   - Container platforms can use cgroups
   - Cloud platforms can use instance types
   - Process platforms can use OS-level limits

6. **Clear Contracts**: The requirements interface creates a clear contract between services and platforms, making the system easier to understand and extend.

7. **Progressive Enhancement**: Platforms can provide additional features beyond basic requirements:
   - AWS platform adds auto-scaling
   - Container platform adds health checks
   - Process platform adds simple monitoring

## Data Flow

### Command Execution Flow

```
User Input
    ↓
Command Handler
    ↓
Service Resolution (name → ServicePlatformInfo)
    ↓
Service Creation (via Factory)
    ↓
Platform Strategy Selection
    ↓
Platform Operation Execution
    ↓
State Management
    ↓
Result Formatting
    ↓
User Output
```

### Service Deployment Resolution

```
Environment Config (JSON file)
    ↓
Platform Resolver
    ↓
ServicePlatformInfo {
  name: string
  platform: Platform
  config: ServiceConfig
}
    ↓
Service Instance
```

### State Management Flow

```
Operation Success
    ↓
Create State Object {
  entity: service name
  platform: platform type
  resources: platform-specific
  startTime: Date
}
    ↓
StateManager.save()
    ↓
File System (state/<env>/<service>.json)
```

## Directory Structure

```
src/
├── commands/              # CLI commands
│   ├── start.ts
│   ├── stop.ts
│   ├── check.ts
│   └── ...
├── services/              # Service definitions
│   ├── service-interface.ts
│   ├── base-service.ts
│   ├── backend-service.ts
│   └── ...
├── platforms/             # Platform implementations
│   ├── platform-strategy.ts
│   ├── process-platform.ts
│   ├── container-platform.ts
│   └── ...
├── lib/                   # Shared utilities
│   ├── cli-logger.ts
│   ├── validators.ts
│   └── ...
├── dashboard/             # Dashboard components
│   ├── dashboard-data.ts
│   ├── dashboard-components.tsx
│   └── ...
└── __tests__/            # Test files
```

## Type System

### Core Types

```typescript
// Platform types
type Platform = 'process' | 'container' | 'aws' | 'external' | 'mock';

// Service types  
type ServiceName = 'backend' | 'frontend' | 'database' | 'filesystem' | 'mcp';

// Configuration types
interface Config {
  projectRoot: string;
  environment: Environment;
  verbose: boolean;
  quiet: boolean;
  dryRun?: boolean;
}

// Results types
interface CommandResults<TResult> {
  command: string;
  executionContext: ExecutionContext;
  results: TResult[];
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    skipped: number;
  };
}
```

### Platform Resources
Discriminated union for type-safe resource handling:

```typescript
type PlatformResources = 
  | { platform: 'process'; data: { pid: number; port?: number } }
  | { platform: 'container'; data: { containerId: string } }
  | { platform: 'aws'; data: { serviceArn: string; taskArn?: string } };
```

## Configuration System

### Environment Configuration
Environments are defined in JSON files:

```
environments/
├── dev.json
├── staging.json
└── prod.json
```

Example configuration:
```json
{
  "platform": {
    "default": "container"
  },
  "services": {
    "backend": {
      "platform": "process",
      "port": 3000,
      "command": "npm start"
    },
    "database": {
      "platform": "container",
      "image": "postgres:15"
    }
  }
}
```

### Service Configuration Resolution
1. Environment-specific config (`environments/<env>.json`)
2. Service-specific overrides
3. Platform defaults
4. Service defaults

## Extension Points

### Adding New Commands
See [ADDING_COMMANDS.md](./ADDING_COMMANDS.md)

1. Create command file in `src/commands/`
2. Define result types and schema
3. Implement handler function
4. Export with CommandBuilder

### Adding New Services
See [ADDING_SERVICES.md](./ADDING_SERVICES.md)

1. Create service file in `src/services/`
2. Extend BaseService
3. Define requirements and capabilities
4. Register in ServiceFactory

### Adding New Platforms
See [ADDING_PLATFORMS.md](./ADDING_PLATFORMS.md)

1. Create platform file in `src/platforms/`
2. Implement PlatformStrategy interface
3. Handle resource provisioning
4. Register in PlatformFactory

## State Management

State is persisted to track running services:

```
state/
└── <environment>/
    ├── backend.json
    ├── frontend.json
    └── database.json
```

State includes:
- Service name and platform
- Start time
- Platform-specific resources
- Endpoint URLs
- Custom metadata

## Testing Strategy

### Unit Tests
- Test individual classes and functions
- Mock external dependencies
- Focus on business logic

### Integration Tests
- Test command execution end-to-end
- Use mock platform for consistency
- Verify state management

### Platform Tests
- Test platform-specific operations
- Mock infrastructure APIs
- Verify resource management

## Security Considerations

### Input Validation
- All user input validated with Zod schemas
- Path traversal prevention
- Command injection protection

### Secret Management
- Platform-specific secret handling
- Environment variable isolation
- No secrets in logs or state files

### Process Isolation
- Services run in isolated contexts
- Resource limits enforced by platforms
- Network isolation where supported

## Performance Considerations

### Lazy Loading
- Platforms loaded on-demand
- Services created only when needed
- Dynamic imports for heavy dependencies

### Parallel Operations
- Services can be operated in parallel
- Platform operations are async
- Batch operations where possible

### Caching
- Platform instances cached (singleton)
- Configuration cached per environment
- State cached during operations

## Error Handling

### Structured Errors
All operations return success/failure with details:

```typescript
{
  success: false,
  error: "Detailed error message",
  entity: "service-name",
  platform: "platform-type"
}
```

### Error Recovery
- Force mode to continue on errors
- Rollback capabilities for critical operations
- State cleanup on failure

### Logging
- Structured logging with log levels
- Sensitive data redaction
- Operation tracing with verbose mode

## Future Extensibility

The architecture supports:
- New service types (just extend BaseService)
- New platforms (implement PlatformStrategy)
- New commands (use CommandBuilder)
- Custom requirements (extend ServiceRequirements)
- Plugin system (via service/platform factories)
- Multi-region/multi-cloud support
- Service mesh integration
- Observability extensions

## Best Practices

1. **Separation of Concerns**: Keep business logic in services, infrastructure in platforms
2. **Type Safety**: Use TypeScript types and Zod validation everywhere
3. **Testability**: Write pure functions, inject dependencies
4. **Consistency**: Use structured results, consistent error handling
5. **Extensibility**: Follow patterns for new components
6. **Documentation**: Document requirements, capabilities, and contracts