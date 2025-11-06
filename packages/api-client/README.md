# @semiont/api-client

**Primary TypeScript SDK for Semiont**

> 🎯 **Use this package for all external integrations, demos, MCP servers, and frontend applications.**
>
> This package provides a type-safe, spec-first SDK that includes:
> - **API Client**: HTTP client for all backend endpoints
> - **TypeScript Types**: Generated from OpenAPI specification
> - **W3C Utilities**: Helpers for annotations, selectors, entity types, and locales
> - **Event Utilities**: Formatting and display helpers for event streams

## Installation

```bash
npm install @semiont/api-client
```

## Quick Start

```typescript
import { SemiontApiClient } from '@semiont/api-client';

// Create client
const client = new SemiontApiClient({
  baseUrl: 'http://localhost:4000',
});

// Authenticate
await client.authenticateLocal('user@example.com', '123456');

// Create a resource
const result = await client.createResource({
  name: 'My Resource',
  content: 'Hello World',
  format: 'text/plain',
  entityTypes: ['example']
});

console.log('Created:', result.resource.id);
```

## Features

- ✅ **Spec-First** - Types generated from OpenAPI specification
- ✅ **Type-Safe** - Full TypeScript types for all operations
- ✅ **Framework-Agnostic** - Works in Node.js, browser, or any JS environment
- ✅ **Built-in Auth** - Local, Google OAuth, refresh tokens
- ✅ **W3C Utilities** - Annotation and selector helpers
- ✅ **Event Utilities** - Formatting and display helpers
- ✅ **Automatic Retry** - Configurable retry with exponential backoff
- ✅ **Error Handling** - Structured `APIError` class

## Documentation

📚 **[Complete Usage Guide](./docs/Usage.md)** - Step-by-step examples

📖 **[API Reference](./docs/API-Reference.md)** - Complete method documentation

### Quick Links

- [Authentication](./docs/Usage.md#authentication) - All auth methods
- [Resources](./docs/Usage.md#resources) - CRUD operations
- [Annotations](./docs/Usage.md#annotations) - W3C Web Annotation Model
- [Entity Detection](./docs/Usage.md#entity-detection-and-jobs) - Async jobs
- [LLM Context](./docs/Usage.md#llm-context) - AI-optimized context
- [Error Handling](./docs/Usage.md#error-handling) - Error handling patterns

## Who Uses This

- ✅ **MCP Server** - Model Context Protocol integration
- ✅ **Frontend** - Web application (can wrap with React hooks)
- ✅ **Demo Scripts** - Example scripts and automation
- ✅ **External Applications** - Third-party integrations
- ✅ **CLI Tools** - Command-line utilities

## Who Should NOT Use This

- ❌ **Backend Internal Code** - Use [`@semiont/core`](../core/) for backend domain logic

**Note**: If you need backend-specific utilities (event sourcing, crypto, type guards), use [`@semiont/core`](../core/). For API consumption and W3C annotation utilities, use this package.

## Configuration

```typescript
const client = new SemiontApiClient({
  baseUrl: 'http://localhost:4000',  // Required
  accessToken: 'your-token',         // Optional
  timeout: 30000,                    // Optional (default: 30000ms)
  retry: 2,                          // Optional (default: 2)
});
```

## Error Handling

```typescript
import { SemiontApiClient, APIError } from '@semiont/api-client';

try {
  const resource = await client.getResource(uri);
} catch (error) {
  if (error instanceof APIError) {
    console.error('API Error:', error.message);
    console.error('Status:', error.status);
  }
}
```

## Utilities

The SDK includes framework-agnostic utilities:

```typescript
import {
  // Annotation utilities
  isReference,
  isHighlight,
  getBodySource,
  getTargetSource,
  getEntityTypes,

  // Selector utilities
  getExactText,
  getTextPositionSelector,
  getTextQuoteSelector,

  // Event utilities
  formatEventType,
  getEventEmoji,
  formatRelativeTime,
} from '@semiont/api-client';
```

See [API Reference](./docs/API-Reference.md#utilities) for complete utility documentation.

## Development

### Regenerate Types from OpenAPI

```bash
npm run generate
```

### Build

```bash
npm run build
```

### Test

```bash
npm test
```

## Architecture

This package enforces the API boundary between:
- **Internal** (backend, CLI) - Direct system access
- **External** (frontend, MCP, demos) - Uses `@semiont/api-client`

See [ARCHITECTURE-API-BOUNDARY.md](../../ARCHITECTURE-API-BOUNDARY.md) for details.

## Examples

See [demo scripts](../../demo/) for complete examples:
- Authentication flows
- Resource creation and management
- Annotation creation and linking
- Event history retrieval
- Entity detection

## License

Apache-2.0
