# Testing Strategy

## Overview

The Semiont CLI uses two distinct testing approaches:

1. **Unit Tests** - Test individual components in isolation using mocks
2. **Integration Tests** - Test the full system with real file operations and environment setup

## Test Types

### Unit Tests

Unit tests are designed to test individual functions and commands in isolation:

- Use mocked file system and external dependencies
- Run without `setup-env.ts` to avoid interference with mocks
- Fast execution
- Located in files matching:
  - `*.unit.test.ts`
  - `init-command.test.ts` (uses mocks)
  - `configure-command.test.ts` (uses mocks)

**Run with:** `npm run test:unit`

### Integration Tests

Integration tests verify the full system behavior:

- Use real file system operations
- Include `setup-env.ts` which creates a test environment
- Test actual command execution and file interactions
- May take longer to execute
- All other `*.test.ts` files not explicitly marked as unit tests

**Run with:** `npm run test:integration`

## Test Commands

```bash
# Run all tests (default vitest config)
npm test

# Run unit tests only
npm run test:unit

# Run integration tests only
npm run test:integration

# Run both unit and integration tests sequentially
npm run test:all

# Watch mode for development
npm run test:watch

# Watch mode for unit tests only
npm run test:watch:unit
```

## Writing Tests

### Unit Test Example

```typescript
// commands/__tests__/my-command.unit.test.ts
import { vi } from 'vitest';

// Mock external dependencies
vi.mock('fs');
vi.mock('../lib/some-module');

// Import after mocks are set up
import { myCommand } from '../my-command';

describe('my command unit tests', () => {
  it('should handle mocked file operations', () => {
    // Test with mocked fs
  });
});
```

### Integration Test Example

```typescript
// commands/__tests__/my-command.integration.test.ts
import { myCommand } from '../my-command';
import * as fs from 'fs';

describe('my command integration tests', () => {
  it('should create real files', async () => {
    // Test with real file system
    // setup-env.ts has already created test environment
  });
});
```

## Migration Notes

When migrating commands to the new unified structure:

1. Unit tests should mock all external dependencies
2. Integration tests should verify the actual command behavior
3. Keep unit and integration tests separate for clarity
4. Use appropriate naming conventions (`.unit.test.ts` or `.integration.test.ts`)

## Environment Setup

The `__tests__/setup-env.ts` file:
- Creates a temporary test directory
- Initializes a test project using the `init` command
- Sets `SEMIONT_ROOT` environment variable
- Cleans up after all tests complete

This setup is only used for integration tests, allowing unit tests to run in complete isolation.