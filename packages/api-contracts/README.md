# Semiont API Types

Shared TypeScript type definitions for the Semiont platform.

## Overview

The `@semiont/api-types` package provides:
- Type-safe API contracts between frontend and backend
- Shared data models and interfaces
- Request/response type definitions
- Common enums and constants

## Usage

```typescript
import { User, AuthResponse, ApiError } from '@semiont/api-types';

// Use types for API responses
const user: User = await api.getUser();

// Use types for request payloads
const response: AuthResponse = await api.login({
  email: 'user@example.com',
  password: 'password'
});
```

## Type Categories

### Authentication Types
- `LoginRequest`, `LoginResponse`
- `SignupRequest`, `SignupResponse`
- `JWTPayload`, `SessionData`

### User Types
- `User`, `UserProfile`
- `UserRole`, `UserPermissions`
- `UpdateUserRequest`

### Common Types
- `ApiResponse<T>` - Generic API response wrapper
- `ApiError` - Standardized error format
- `PaginatedResponse<T>` - Pagination wrapper
- `QueryParams` - Common query parameters

## Development

```bash
# Build the package
npm run build

# Watch for changes
npm run watch
```

## Best Practices

1. **Keep types in sync**: Changes here affect both frontend and backend
2. **Use strict types**: Avoid `any` and prefer union types
3. **Document complex types**: Add JSDoc comments for clarity
4. **Version carefully**: Breaking changes affect multiple packages

## API Reference

All types are exported from the main index:

```typescript
export * from './auth';
export * from './user';
export * from './common';
```