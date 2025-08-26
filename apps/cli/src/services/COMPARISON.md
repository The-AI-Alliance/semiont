# Before vs After: CLI Service Architecture

## Size Comparison

### Before
- `commands/start.ts`: 837 lines
- All logic in one file
- Complex nested switches
- Deployment logic mixed with service logic

### After
- `commands/start-new.ts`: 180 lines (-78% reduction)
- `services/` directory: ~800 lines total (but organized)
- Each service: ~150 lines
- Clear separation of concerns

## Code Complexity

### Before: Mixed Concerns
```typescript
// Line 319-603: One giant function
async function startProcessService(serviceInfo, options) {
  switch (serviceInfo.name) {
    case 'backend':
      // 100 lines of backend logic
      // Mixed with deployment-specific code
      if (deployment === 'process') { /* ... */ }
      else if (deployment === 'container') { /* ... */ }
      // ...
    case 'frontend':
      // Another 100 lines
      // ...
    case 'database':
      // More cases...
  }
}
```

### After: Separated Concerns
```typescript
// Service owns WHAT
class BackendService extends BaseService {
  preStart() { /* Backend-specific setup */ }
  doStart() { /* Delegates to deployment */ }
}

// Command is just coordination
async function start(serviceName, options) {
  const service = ServiceFactory.create(serviceName, deployment, config);
  return await service.start();
}
```

## Finding Code

### Before: Hunt Through Switches
"Where is backend container logic?"
- Start at line 78
- Jump to line 186 (container section)
- Jump to line 236 (backend in container)
- Logic scattered across 3 locations

### After: Predictable Location
"Where is backend container logic?"
- `backend-service.ts` → `startAsContainer()` method
- All backend logic in one file
- Container patterns visible across services

## Adding Features

### Before: Edit Multiple Places
Add health check waiting to backend:
1. Edit process backend (line 349-402)
2. Edit container backend (line 236-288)  
3. Edit AWS backend (line 110-133)
4. Hope you didn't miss any

### After: Edit One Place
Add health check waiting to backend:
1. Edit `backend-service.ts` → `postStart()` method
2. All deployment types get it automatically

## Testing

### Before: Hard to Mock
```typescript
// How do you test just backend logic?
// It's buried in 837 lines with spawn, execSync, etc.
```

### After: Easy to Mock
```typescript
// Test service logic in isolation
const mockStrategy = { start: jest.fn() };
const service = new BackendService('process', config);
service.strategy = mockStrategy;
await service.start();
expect(mockStrategy.start).toHaveBeenCalled();
```

## Next Migration Steps

When we add `stop()`:
1. Add to Service interface
2. Add abstract method to BaseService
3. Implement in each service (5 files, ~20 lines each)
4. Update start-new.ts handler (5 lines)

Compare to old approach:
- Would need to edit 4 different stop functions
- Each with nested service switches
- Hundreds of lines of changes

## Performance

### Before
- 837 lines parsed/compiled even if starting one service
- Large function with deep nesting

### After  
- Only loads needed service class
- Smaller functions, better JIT optimization
- Tree-shakeable in theory

## Developer Experience

### Before
```bash
# "I need to change backend database config"
# Opens start.ts
# Scrolls... scrolls... scrolls...
# Ctrl+F "backend"... 47 matches
# Finally finds it on line 358
```

### After
```bash
# "I need to change backend database config"
# Opens backend-service.ts
# It's in ensureDatabaseConfig() method
# Done
```