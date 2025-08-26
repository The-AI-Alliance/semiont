# Next Steps for Service Migration

## Immediate (Test & Validate)

1. **Test the new implementation**
   ```bash
   # Replace old start with new
   mv commands/start.ts commands/start-old.ts
   mv commands/start-new.ts commands/start.ts
   
   # Test locally
   semiont start --environment local --service backend
   
   # Run CI tests
   npm test
   ```

2. **Fix any issues found**
   - Type mismatches
   - Missing environment variables
   - Path resolution issues

## Phase 2: Add `stop()` Method

1. **Add to Service interface**
   ```typescript
   interface Service {
     start(): Promise<StartResult>;
     stop(): Promise<StopResult>;  // NEW
   }
   ```

2. **Implement in each service**
   - Similar pattern to start()
   - Each service knows how to stop itself

3. **Update commands/stop.ts**
   - Use ServiceFactory
   - ~50 lines instead of current 400+

## Phase 3: Add `check()` Method

1. **Health checks across all services**
2. **Service-specific health logic**
3. **Unified health reporting**

## Phase 4: Extract Deployment Strategies

Once we have 3-4 methods and patterns are clear:

1. **Create DeploymentStrategy interface**
   ```typescript
   interface DeploymentStrategy {
     spawn(command: string[], options: SpawnOptions): Promise<number>;
     kill(pid: number): Promise<void>;
     getHealthEndpoint(): string;
     // etc.
   }
   ```

2. **Move deployment-specific code**
   - ProcessStrategy
   - ContainerStrategy  
   - AWSStrategy
   - ExternalStrategy

3. **Services become even simpler**
   - Just business logic
   - Delegate HOW to strategy

## Phase 5: Add Remaining Commands

Priority order based on complexity:
1. `logs` - Read-only, straightforward
2. `update` - Service-specific logic
3. `backup/restore` - Most complex
4. `publish` - Deployment-specific

## Success Criteria

- [ ] All tests passing
- [ ] Commands feel more predictable
- [ ] Code is easier to find and modify
- [ ] New service can be added in <30 minutes
- [ ] Deployment changes don't affect service logic

## Rollback Plan

If issues arise:
1. Keep `start-old.ts` for quick revert
2. Can run both in parallel during migration
3. Feature flag to choose implementation

## Benefits Already Visible

- **78% code reduction** in command file (837 → 180 lines)
- **Service cohesion** - Backend logic all in one place
- **Clear extension points** - Easy to see where to add new logic
- **Testable** - Can mock deployment, test service logic
- **Maintainable** - Find code quickly, change in one place

## Questions to Consider

1. **Should MCP be a service?** It's quite different from others
2. **Agent service** - Not implemented yet, what will it need?
3. **Service dependencies** - Backend needs database, how to express?
4. **Parallel starts** - Can we start independent services simultaneously?
5. **Configuration** - Should services load their own config?

## For Discussion

The current implementation keeps deployment logic inline in each service (startAsProcess, startAsContainer, etc). This is intentional for Phase 1 to:
- Keep changes incremental
- See patterns emerge naturally
- Avoid premature abstraction

Once we have 2-3 commands implemented, the right abstraction for deployment strategies will be obvious.