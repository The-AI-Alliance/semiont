# CLI Service-Oriented Architecture Design

## Core Concept: Service as Primary Abstraction

Services are the primary organizing principle, with deployment types as strategies within each service.

## Architecture Overview

```typescript
// Base service interface - all services implement these commands
interface Service {
  start(): Promise<void>;
  stop(): Promise<void>;
  check(): Promise<HealthStatus>;
  update(): Promise<void>;
  publish(): Promise<void>;
  backup(): Promise<void>;
  restore(backupId: string): Promise<void>;
  logs(options: LogOptions): Promise<void>;
}

// Service factory resolves the right implementation
type ServiceFactory = (
  serviceName: ServiceName,
  deploymentType: DeploymentType,
  config: Config
) => Service;
```

## Multiple Dispatch Pattern in TypeScript

Since TypeScript lacks true multiple dispatch, we use a hybrid approach:

1. **Service Classes** - Primary abstraction, one per service type
2. **Deployment Strategies** - Encapsulate deployment-specific logic
3. **Method Delegation** - Services delegate to strategies when needed

## Example Implementation

```typescript
// Deployment strategy interface
interface DeploymentStrategy {
  spawn(command: string, args: string[]): Promise<void>;
  kill(processId: string): Promise<void>;
  getLogs(): Promise<string[]>;
  getHealthEndpoint(): string;
}

// Base service with shared logic
abstract class BaseService implements Service {
  protected deployment: DeploymentStrategy;
  
  constructor(deploymentType: DeploymentType, config: Config) {
    this.deployment = DeploymentStrategyFactory.create(deploymentType, config);
  }
  
  // Common health check logic
  async check(): Promise<HealthStatus> {
    const endpoint = this.deployment.getHealthEndpoint();
    // Shared health check logic
  }
}

// Backend service with service-specific logic
class BackendService extends BaseService {
  async start(): Promise<void> {
    // Backend-specific setup
    await this.ensureDatabase();
    await this.deployment.spawn('npm', ['run', 'start:backend']);
  }
  
  private async ensureDatabase(): Promise<void> {
    // Backend-specific database logic
  }
}
```

## Benefits

1. **Service Cohesion** - All backend logic lives together
2. **Deployment Flexibility** - Easy to add new deployment types
3. **Clear Responsibilities** - Services own business logic, strategies own deployment mechanics
4. **Testability** - Mock strategies for testing service logic
5. **Extensibility** - Add new services or deployment types without touching existing code

## Migration Path

1. Extract service-specific logic from current commands
2. Create service classes with current logic
3. Refactor deployment-type conditionals into strategy objects
4. Update command entry points to use service factory
5. Gradually migrate complex scenarios

## Trade-offs

- **Pro**: Clear separation of concerns
- **Pro**: Service logic stays together
- **Pro**: Easier to understand service behavior
- **Con**: More classes/files initially
- **Con**: Some duplication across deployment strategies
- **Mitigation**: Share common deployment logic via composition