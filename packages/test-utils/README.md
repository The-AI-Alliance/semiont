# Semiont Test Utils

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml)

Shared testing utilities and mock factories for the Semiont platform.

## Overview

The `@semiont/test-utils` package provides:
- Mock data factories for consistent test data
- Test environment setup utilities
- Common test helpers and assertions
- Reusable test fixtures

## Usage

```typescript
import { 
  createMockUser, 
  createMockDatabase,
  setupTestEnvironment 
} from '@semiont/test-utils';

describe('User Service', () => {
  beforeAll(() => {
    setupTestEnvironment();
  });

  it('should create user', () => {
    const mockUser = createMockUser({
      email: 'test@example.com'
    });
    
    // Use mock data in tests
    expect(mockUser.id).toBeDefined();
    expect(mockUser.email).toBe('test@example.com');
  });
});
```

## Mock Factories

### User Mocks
```typescript
createMockUser(overrides?: Partial<User>): User
createMockUserProfile(overrides?: Partial<UserProfile>): UserProfile
createMockSession(overrides?: Partial<Session>): Session
```

### Database Mocks
```typescript
createMockDatabase(): MockDatabase
createMockConnection(options?: ConnectionOptions): MockConnection
```

### API Mocks
```typescript
createMockApiResponse<T>(data: T): ApiResponse<T>
createMockApiError(code: string, message: string): ApiError
```

## Test Environments

### Frontend Environment
```typescript
import { setupFrontendTestEnvironment } from '@semiont/test-utils/environments/frontend';

setupFrontendTestEnvironment({
  mockApi: true,
  resetBetweenTests: true
});
```

### Backend Environment
```typescript
import { setupBackendTestEnvironment } from '@semiont/test-utils/environments/backend';

setupBackendTestEnvironment({
  database: 'test',
  migrations: true
});
```

### CLI Environment
```typescript
import { setupCLITestEnvironment } from '@semiont/test-utils/environments/cli';

setupCLITestEnvironment({
  mockFilesystem: true,
  captureOutput: true
});
```

## Test Helpers

### Assertions
```typescript
expectApiSuccess(response: any): void
expectApiError(response: any, expectedCode: string): void
expectValidUser(user: any): void
```

### Utilities
```typescript
waitForCondition(fn: () => boolean, timeout?: number): Promise<void>
mockConsole(): ConsoleMock
captureOutput(fn: () => void): string[]
```

## Best Practices

1. **Use factories for consistency**: Always use mock factories instead of hardcoded test data
2. **Reset between tests**: Use environment setup to ensure clean state
3. **Share common scenarios**: Create reusable test scenarios in this package
4. **Keep mocks realistic**: Mock data should match production data structure

## Development

```bash
# Build the package
npm run build

# Run tests
npm test
```