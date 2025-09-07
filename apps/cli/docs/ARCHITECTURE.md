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

The Semiont CLI is built around five fundamental concepts that work together:

### 1. Environment
**Location:** `environments/` directory  
**Purpose:** Define deployment contexts and service configurations  
**Pattern:** Environment files specify which services exist and how they're deployed

Environments represent different deployment contexts (dev, staging, production) and are the primary configuration mechanism:
- **Configuration Files**: JSON files in `environments/` directory
- **Service Definitions**: Which services exist in this environment
- **Platform Mappings**: Which platform each service uses
- **Service Configuration**: Environment-specific settings
- **Resolution**: `--environment` flag or `SEMIONT_ENV` variable (required)

### 2. Commands
**Location:** `src/core/commands/`  
**Purpose:** Define CLI operations that users can execute  
**Pattern:** Commands use the MultiServiceExecutor with CommandDescriptor configuration

Commands are responsible for:
- Defining their schema and argument specifications
- Providing a CommandDescriptor that configures execution behavior
- Defining how handler results are transformed to CommandResult
- Optional pre-execution hooks for special cases

The command execution is orchestrated by the MultiServiceExecutor pattern:

#### Core Command Modules

**Multi-Service Executor** (`src/core/multi-service-executor.ts`) → Single execution path
- Orchestrates all command execution with consistent behavior
- Resolves environment (--environment flag or SEMIONT_ENV)
- Executes pre-execution hooks from CommandDescriptor
- For each service: resolves platform → determines serviceType → finds handler → executes
- Aggregates results with consistent error handling

**Command Descriptor** (`src/core/command-descriptor.ts`) → Command configuration
- Defines how commands are executed within MultiServiceExecutor
- `buildResult`: Transforms handler results to CommandResult
- `buildServiceConfig`: Merges options with service configuration
- `extractHandlerOptions`: Extracts handler-specific options
- `preExecute`: Optional hook for synthetic services (e.g., AWS stack)

**Command Result** (`src/core/command-result.ts`) → Unified result type
- Generic CommandResult type with extensions field
- Replaces individual result types (StartResult, CheckResult, etc.)
- Provides consistent structure across all commands

**Service Discovery** (`src/core/service-discovery.ts`) → What services exist?
- Discovers services from environment configuration files
- Manages built-in services (frontend, backend, database, filesystem)
- Loads service-specific configuration

**Command-Service Matcher** (`src/core/command-service-matcher.ts`) → Which work together?
- Determines which commands can operate on which services
- Resolves "all" to the list of applicable services
- Checks service-declared command capabilities via annotations

Example flow:
```typescript
CLI entry → MultiServiceExecutor → resolve environment (--env or SEMIONT_ENV) →
load environment config → resolve services → preExecute hook →
for each service: check service type declaration → determine platform → 
find handler → execute handler → transform result → aggregate results
```

## Concept Relationships

```
Environment
    ↓ defines
Services + Platform Assignments
    ↓ services declare
Service Type (via annotations)
    ↓ resolved by
MultiServiceExecutor
    ↓ executes
Commands
    ↓ finds
Handlers (Platform + ServiceType + Command)
    ↓ operates on
Infrastructure
```

### How They Work Together

1. **Environment** defines the deployment context:
   - Which services exist
   - Which platform each service uses
   - Service-specific configuration

2. **Services** declare what they need:
   - Business logic and requirements
   - Platform-agnostic implementation
   - Service type declaration via annotations
   - Command capability declarations

3. **Service Types** categorize services:
   - High-level service categories (frontend, backend, database, etc.)
   - Declared by services themselves via `service/type` annotation
   - Platform may map to specific implementations

4. **Commands** define operations:
   - User-facing CLI operations
   - Use MultiServiceExecutor for consistency

5. **Platforms** provide infrastructure:
   - Implement handlers for each service type
   - Manage platform-specific resources

### 3. Services  
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
      annotations: {
        'service/type': SERVICE_TYPES.BACKEND,
        'command/supports-publish': 'true',
        'command/supports-update': 'true'
      },
      resources: { memory: '512Mi', cpu: '1' },
      network: { ports: [3000] }
    };
  }
}
```

### 4. Service Types
**Location:** `src/core/service-types.ts`  
**Purpose:** High-level service categorization  
**Pattern:** Services declare their type, platforms map to implementations

Service types are high-level categories declared by services:
- **Core Types**: frontend, backend, database, filesystem, worker, mcp, inference
- **Declaration**: Services use `service/type` annotation in requirements
- **Platform Mapping**: Platforms may map types to specific implementations (e.g., AWS maps frontend → s3-cloudfront)
- **Handler Resolution**: Platform + ServiceType + Command = Specific Handler

### 5. Platforms
**Location:** `src/platforms/`  
**Purpose:** Implement infrastructure-specific operations  
**Pattern:** Platforms extend the abstract Platform class and provide handlers

Platforms (extending `src/core/platform.ts`):
- Interpret service requirements and provision resources
- Map service types to platform-specific implementations
- Provide handlers for each service type and command combination
- Manage platform-specific state and resource tracking
- Implement credential validation and log collection

#### Platform Handlers Architecture

All platforms now use a unified handler-based architecture:

**Handler Pattern** (`src/platforms/*/handlers/`)
- Each service type has dedicated handlers for commands
- Handlers self-declare their command, platform, and serviceType
- Automatic registration via HandlerRegistry
- Handlers receive context with options passed through from commands

Example handler structure:
```typescript
// posix/handlers/web-start.ts
export const webStartDescriptor: HandlerDescriptor<StartHandlerContext, StartHandlerResult> = {
  command: 'start',
  platform: 'posix',
  serviceType: 'web',
  handler: async (context) => {
    // Web service start logic for POSIX systems
    // Access to context.service and context.options
    // Returns StartHandlerResult
  }
};

// aws/handlers/lambda-check.ts
export const lambdaCheckDescriptor: HandlerDescriptor = {
  command: 'check',
  platform: 'aws',
  serviceType: 'lambda',
  handler: lambdaCheckHandler,
  requiresDiscovery: true  // Needs CloudFormation resource discovery
};
```

Benefits of unified handler architecture:
- **Modularity**: Each service type's logic is isolated per platform
- **Testability**: Handlers can be tested independently
- **Extensibility**: New handlers added without modifying platform class
- **Self-contained**: Each handler manages its own concerns
- **Auto-discovery**: Handlers self-register with platform, command, and serviceType
- **Consistent execution**: MultiServiceExecutor ensures uniform behavior across all commands
- **Type safety**: CommandDescriptor and HandlerDescriptor provide strong typing

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

### Abstract Class Pattern (Platforms)
Each platform extends the abstract `Platform` class, providing consistent behavior:

```typescript
abstract class Platform {
  abstract buildHandlerContextExtensions(service, requiresDiscovery): Promise<any>;
  abstract collectLogs(service, options): Promise<LogEntry[]>;
  determineServiceType(service): string { /* uses service declarations */ }
  // ... other operations with default implementations
}
```

### Factory Pattern (Services & Platforms)
Factories create appropriate instances based on configuration:

```typescript
ServiceFactory.create(name, platform, config)
PlatformFactory.getPlatform(type)
```

### Command Descriptor Pattern
Commands use CommandDescriptor with MultiServiceExecutor:

```typescript
const startDescriptor: CommandDescriptor<StartOptions> = {
  name: 'start',
  buildResult: (handlerResult, service, platform, serviceType) => ({
    entity: service.name,
    platform: platform.type,
    success: handlerResult.success,
    timestamp: new Date(),
    error: handlerResult.error,
    extensions: {
      start: {
        endpoint: handlerResult.endpoint,
        resources: handlerResult.resources
      }
    }
  }),
  buildServiceConfig: (options, serviceInfo) => ({
    verbose: options.verbose,
    quiet: options.quiet,
    environment: options.environment
  }),
  extractHandlerOptions: (options) => ({
    force: options.force,
    restart: options.restart
  })
};

// Command uses MultiServiceExecutor
export const startCommand = async (options: StartOptions) => {
  const executor = new MultiServiceExecutor(startDescriptor);
  return executor.execute(options);
};
```

### Requirements Pattern
Services declare requirements and capabilities; platforms fulfill them:

```typescript
Service: "I am a backend service (service/type), I need 512MB RAM and port 3000"
Platform: "I'll map your type to my implementation and provide resources"
```

### Publish and Update Contract

The `publish` and `update` commands follow a strict separation of concerns:

**Publish Command:**
- Builds application artifacts (binaries, containers, packages)
- Pushes artifacts to registries (ECR, Docker Hub, npm, etc.)
- Creates deployment metadata (task definitions, manifests)
- **Does NOT modify running services**
- Returns artifact information for tracking

**Update Command:**
- Checks for newer versions created by publish
- Deploys new versions to running services
- Handles both immutable (git hash) and mutable (`:latest`) tags
- Monitors deployment progress
- Reports success/failure

**Example Flow (ECS):**
```typescript
// 1. Publish creates new task definition revision
publish: "Built image, pushed to ECR, created task definition revision 75"

// 2. Update deploys that revision
update: "Found newer revision 75 (current: 74), deploying..."
```

This separation ensures:
- Clear deployment audit trail
- Ability to publish without immediate deployment
- Support for both CI/CD and manual deployment workflows
- Rollback capabilities (update to previous revision)

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
class ContainerPlatform extends Platform {
  // Platform determines service type from service declarations
  determineServiceType(service: Service): string {
    const requirements = service.getRequirements();
    const declaredType = requirements.annotations['service/type'];
    // Platform can map types if needed (but usually uses as-is)
    return declaredType;
  }
  
  // Handler manages the actual start logic
  async buildHandlerContextExtensions(service: Service): Promise<any> {
    return {
      runtime: this.detectContainerRuntime(),
      containerName: this.getResourceName(service)
    };
  }
}

// Handler for backend services on container platform
const backendStartHandler = async (context) => {
  const requirements = context.service.getRequirements();
  
  // Translate requirements into Docker configuration
  const dockerConfig = {
    Image: context.service.config.image,
    HostConfig: {
      Memory: parseMemory(requirements.resources?.memory),
      CpuShares: parseCpu(requirements.resources?.cpu),
      PortBindings: mapPorts(requirements.network?.ports)
    },
    Env: formatEnvironment(requirements.environment)
  };
  
  // Start container with translated configuration
  const container = await docker.createContainer(dockerConfig);
  await container.start();
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
type PlatformType = 'posix' | 'container' | 'aws' | 'external' | 'mock';

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
interface CommandResult {
  entity: ServiceName;
  platform: PlatformType;
  success: boolean;
  timestamp: Date;
  error?: string;
  metadata?: Record<string, any>;
  extensions?: CommandExtensions;
}

interface CommandResults {
  command: string;
  executionContext: ExecutionContext;
  results: CommandResult[];
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
  | { platform: 'posix'; data: { pid: number; port?: number; command: string; workingDirectory: string } }
  | { platform: 'container'; data: { containerId: string } }
  | { platform: 'aws'; data: { serviceArn: string; taskArn?: string } };
```

## Configuration System

### Environment as the Primary Configuration

Environments are the central configuration mechanism in Semiont:

```
environments/
├── dev.json        # Local development
├── staging.json    # Staging deployment
└── prod.json       # Production deployment
```

#### Environment Resolution
1. **Command Line**: `--environment dev` (highest priority)
2. **Environment Variable**: `SEMIONT_ENV=dev`
3. **Error**: If neither is set, execution fails with clear message

#### Example Environment Configuration
```json
{
  "platform": {
    "default": "container"  // Default platform for services
  },
  "services": {
    "backend": {
      "platform": "posix",    // Override default platform
      "port": 3000,
      "command": "npm start",
      "env": {                  // Service-specific env vars
        "NODE_ENV": "development",
        "LOG_LEVEL": "debug"
      }
    },
    "database": {
      "platform": "container",
      "image": "postgres:15",
      "port": 5432,
      "volumes": ["/data/postgres:/var/lib/postgresql/data"]
    },
    "worker": {
      "platform": "aws",
      "serviceType": "lambda",  // Hint for service type
      "memory": 512,
      "timeout": 300
    }
  },
  "aws": {                      // Platform-specific config
    "region": "us-west-2",
    "profile": "staging"
  }
}
```

### Configuration Resolution Order
1. **Environment Selection**: `--environment` or `SEMIONT_ENV` (required)
2. **Environment Config**: Load `environments/<env>.json`
3. **Service Discovery**: Find all services defined in environment
4. **Platform Resolution**: Determine platform for each service
5. **Service Type Determination**: Based on service characteristics
6. **Handler Selection**: Find handler for (platform, serviceType, command)
7. **Configuration Merge**:
   - Environment-specific config
   - Service-specific overrides
   - Platform defaults
   - Service defaults

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

### Adding New Service Types
See [ADDING_SERVICE_TYPES.md](./ADDING_SERVICE_TYPES.md)

1. Add type to SERVICE_TYPES constant
2. Create services that declare the type
3. Implement handlers for each platform
4. Optional: Add type-specific commands

### Adding New Platforms
See [ADDING_PLATFORMS.md](./ADDING_PLATFORMS.md)

1. Create platform file in `src/platforms/`
2. Extend the abstract Platform class
3. Implement handlers for each service type
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
- New platforms (extend Platform class)
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