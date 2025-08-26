# Migration Plan: Service-Oriented CLI

## Phase 1: Start Command (Week 1)
Implement minimal Service interface with just `start()` method

```typescript
// services/types.ts
export interface MinimalService {
  start(): Promise<void>;
}

// services/backend.ts
export class BackendService implements MinimalService {
  async start() {
    // Migrate logic from commands/start.ts
  }
}
```

### Steps:
1. Create service classes with existing start logic
2. Keep deployment type handling inline initially
3. Update `commands/start.ts` to use service factory
4. Test with: `semiont start backend`, `semiont start frontend`, etc.
5. Ensure CI tests still pass

## Phase 2: Extract Deployment Strategies (Week 1-2)
Once start works, extract deployment patterns

```typescript
// Before: Inline in service
if (deployment === 'process') {
  spawn('npm', ['run', 'dev']);
} else if (deployment === 'container') {
  execSync('docker-compose up -d');
}

// After: Strategy pattern
await this.strategy.start();
```

### Steps:
1. Identify common deployment patterns across services
2. Create DeploymentStrategy interface
3. Move deployment-specific code to strategies
4. Services retain business logic only

## Phase 3: Add Commands Incrementally (Week 2-3)
Add one command at a time across all services

Priority order (based on complexity/usage):
1. `stop` - Symmetric to start, proves cleanup works
2. `check` - Validates health check abstraction
3. `logs` - Tests read-only operations
4. `update` - Service-specific logic heavy
5. `backup/restore` - Most complex, service-specific
6. `publish` - Deployment-specific, less frequently used

## Phase 4: Remove Old Code (Week 3)
1. Delete old command implementations
2. Remove deployment type conditionals
3. Clean up duplicate code

## Escape Hatches

### Service-Specific Commands
Some commands might not fit all services:
```typescript
interface OptionalCommands {
  provision?(): Promise<void>;  // Only backend needs this
  buildAssets?(): Promise<void>; // Only frontend needs this
}
```

### Deployment-Specific Behavior
When truly unique to one combination:
```typescript
class BackendService {
  async start() {
    if (this.deployment === 'aws' && this.config.environment === 'prod') {
      // Special AWS prod-only behavior
      await this.updateSecrets();
    }
    await super.start();
  }
}
```

## Success Metrics
- [ ] All existing tests pass
- [ ] Commands feel more predictable
- [ ] Adding new service requires minimal boilerplate
- [ ] Deployment type changes are isolated
- [ ] Code in `commands/` directory is under 50 lines per file

## Rollback Plan
Keep old implementation in `commands/legacy/` during migration. If issues arise:
1. Revert `commands/start.ts` to use legacy code
2. Services remain but unused
3. No user-facing changes