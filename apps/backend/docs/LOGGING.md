# Backend Logging

Comprehensive Winston-based logging with configurable log levels, structured metadata, and request correlation for debugging and monitoring.

## Table of Contents

- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Log Levels](#log-levels)
- [What Gets Logged](#what-gets-logged)
- [Request Correlation](#request-correlation)
- [Using Loggers in Code](#using-loggers-in-code)
- [Log Output Examples](#log-output-examples)
- [Troubleshooting](#troubleshooting)
- [Production Considerations](#production-considerations)

## Quick Start

### Set Log Level

Control logging verbosity with the `logLevel` setting in your environment configuration file.

**Option 1: Edit environment file** (recommended for persistent changes):

```bash
# Edit environments/{env}.json (e.g., environments/local.json)
{
  ...
  "logLevel": "debug",  // or http, info, warn, error
  ...
}

# Then rebuild and start
npm run build
npm start
```

**Option 2: Override with LOG_LEVEL environment variable** (temporary for this run):

```bash
# Debug mode - see everything (HTTP requests, auth, errors, debug messages)
LOG_LEVEL=debug npm start

# HTTP mode - see HTTP requests + info/warn/error
LOG_LEVEL=http npm start

# Info mode - see info/warn/error only
LOG_LEVEL=info npm start

# Error mode - see errors only
LOG_LEVEL=error npm start
```

**Default levels by environment:**
- local, ci: `debug` (full verbosity for development)
- staging: `http` (HTTP requests + info/warn/error)
- production: `info` (info/warn/error only)
- test: `error` (errors only)

### View Logs

**Console Output** (development):
```bash
# Logs appear in terminal with timestamps
2025-12-29 19:38:45 [INFO] Logger initialized {"level":"debug","format":"simple","transports":["console","file"]}
2025-12-29 19:38:46 [HTTP] Incoming request {"type":"request_incoming","method":"POST","path":"/api/resources"}
2025-12-29 19:38:46 [WARN] Authentication failed: Missing Authorization header {"type":"auth_failed","reason":"missing_header"}
```

**Log Files** (when file transport enabled):
- `logs/combined.log` - All logs at configured level
- `logs/error.log` - Error-level logs only

### Debugging 401 Errors

When you get 401 errors, set `logLevel: "debug"` to see exactly why:

```bash
# Edit your environment file (e.g., environments/local.json)
{
  ...
  "logLevel": "debug",
  ...
}

# Then rebuild and restart
npm run build
npm start

# Or override temporarily with environment variable
LOG_LEVEL=debug npm start

# Now you'll see detailed auth logs:
# - "Authentication failed: Missing Authorization header" → Client didn't send token
# - "Authentication failed: Empty token" → Token was empty after "Bearer "
# - "Authentication failed: Invalid token" → Token verification failed (expired, wrong secret, etc.)
```

**Note:** Development environments (local, ci) already have `"logLevel": "debug"` configured.

## Configuration

### Log Level Configuration

Logging is configured via the `logLevel` field in your environment configuration file (`environments/{env}.json`).

**Configuration file** (`environments/local.json`):
```json
{
  "logLevel": "debug"
}
```

**Available log levels:**
| Level | When to Use | What Gets Logged |
|-------|-------------|------------------|
| `error` | Production (minimal) | Critical failures only |
| `warn` | Production | Errors + warnings (auth failures, validation errors) |
| `info` | Production (default) | Errors + warnings + important events |
| `http` | Staging/debugging | All of above + HTTP request/response logging |
| `debug` | Development (default) | Everything including detailed auth flow |

**Configuration precedence:**
1. `LOG_LEVEL` environment variable (temporary override)
2. `logLevel` in `environments/{env}.json` (recommended)
3. Default: `info`

**Other environment variables:**
| Variable | Values | Default | Description |
|----------|--------|---------|-------------|
| `LOG_FORMAT` | `json`, `simple` | `json` | Log output format |
| `NODE_ENV` | `development`, `production`, `test` | `development` | Runtime environment |

### Log Formats

**JSON Format** (default, best for production):
```json
{
  "level": "warn",
  "message": "Authentication failed: Missing Authorization header",
  "timestamp": "2025-12-29T19:38:45.123Z",
  "type": "auth_failed",
  "reason": "missing_header",
  "path": "/api/resources",
  "method": "POST",
  "requestId": "a1b2c3d4-5e6f-7g8h-9i0j-k1l2m3n4o5p6"
}
```

**Simple Format** (human-readable for development):
```
2025-12-29 19:38:45 [WARN] Authentication failed: Missing Authorization header {"type":"auth_failed","reason":"missing_header","path":"/api/resources","method":"POST","requestId":"a1b2c3d4-5e6f-7g8h-9i0j-k1l2m3n4o5p6"}
```

## Log Levels

Logging follows Winston's standard levels in order of verbosity:

| Level | When to Use | Example Use Cases |
|-------|-------------|-------------------|
| `error` | Critical failures | Unhandled exceptions, database failures, service crashes |
| `warn` | Problems that don't crash | Auth failures, validation errors, deprecated API usage |
| `info` | Important events | Server startup, SSE connections, configuration loaded |
| `http` | HTTP traffic | Request/response logging, timing, status codes |
| `debug` | Detailed debugging | Auth success details, variable values, flow tracing |

**Log Level Hierarchy**:
- `error` → Shows only errors
- `warn` → Shows errors + warnings
- `info` → Shows errors + warnings + info messages
- `http` → Shows errors + warnings + info + HTTP requests
- `debug` → Shows everything

## What Gets Logged

### 1. HTTP Request/Response Logging

**Middleware**: `requestLoggerMiddleware` (level: `http`)

**Incoming Requests**:
```json
{
  "level": "http",
  "message": "Incoming request",
  "type": "request_incoming",
  "method": "POST",
  "path": "/api/resources",
  "query": { "filter": "active" },
  "userAgent": "Mozilla/5.0...",
  "requestId": "a1b2c3d4..."
}
```

**Outgoing Responses**:
```json
{
  "level": "http",
  "message": "Outgoing response",
  "type": "request_outgoing",
  "method": "POST",
  "path": "/api/resources",
  "status": 201,
  "duration": 123,
  "requestId": "a1b2c3d4..."
}
```

### 2. Authentication Logging

**Middleware**: Enhanced `authMiddleware` (level: `warn` for failures, `debug` for success)

**Auth Success** (debug level):
```json
{
  "level": "debug",
  "message": "Authentication successful",
  "type": "auth_success",
  "userId": "user-123",
  "email": "user@example.com",
  "path": "/api/resources",
  "method": "POST",
  "requestId": "a1b2c3d4..."
}
```

**Auth Failures** (warn level):

Missing header:
```json
{
  "level": "warn",
  "message": "Authentication failed: Missing Authorization header",
  "type": "auth_failed",
  "reason": "missing_header",
  "path": "/api/resources",
  "method": "POST",
  "requestId": "a1b2c3d4..."
}
```

Empty token:
```json
{
  "level": "warn",
  "message": "Authentication failed: Empty token",
  "type": "auth_failed",
  "reason": "empty_token",
  "path": "/api/resources",
  "method": "POST",
  "requestId": "a1b2c3d4..."
}
```

Invalid token:
```json
{
  "level": "warn",
  "message": "Authentication failed: Invalid token",
  "type": "auth_failed",
  "reason": "invalid_token",
  "path": "/api/resources",
  "method": "POST",
  "error": "jwt expired",
  "requestId": "a1b2c3d4..."
}
```

### 3. Error Logging

**Middleware**: `errorLoggerMiddleware` (level: `error`)

**Unhandled Errors**:
```json
{
  "level": "error",
  "message": "Unhandled error during request processing",
  "type": "unhandled_error",
  "method": "POST",
  "path": "/api/resources",
  "error": "Cannot read property 'id' of undefined",
  "stack": "TypeError: Cannot read property 'id' of undefined\n    at ...",
  "name": "TypeError",
  "requestId": "a1b2c3d4..."
}
```

### 4. System Events

**Logger Initialization** (level: `info`):
```json
{
  "level": "info",
  "message": "Logger initialized",
  "level": "debug",
  "format": "json",
  "transports": ["console", "file"]
}
```

## Request Correlation

Every request gets a unique request ID (UUID) for tracking logs across multiple operations.

### How It Works

1. **Request ID Middleware** (`requestIdMiddleware`) generates UUID
2. Request ID added to context and response header (`X-Request-ID`)
3. Request-scoped logger created with request ID in metadata
4. All logs from that request include the same request ID

### Example: Tracking a Request Flow

All these logs share the same `requestId` for easy filtering:

```json
// 1. Request arrives
{"level":"http","message":"Incoming request","requestId":"abc-123",...}

// 2. Auth check
{"level":"warn","message":"Authentication failed: Missing Authorization header","requestId":"abc-123",...}

// 3. Response sent
{"level":"http","message":"Outgoing response","status":401,"requestId":"abc-123",...}
```

### Finding Related Logs

**In JSON logs** (grep/jq):
```bash
# Find all logs for a specific request
cat logs/combined.log | jq 'select(.requestId == "abc-123")'

# Find all auth failures
cat logs/combined.log | jq 'select(.type == "auth_failed")'
```

**In application code**:
```typescript
// Get request-scoped logger
const logger = c.get('logger');

// All logs include requestId automatically
logger.info('Processing resource', { resourceId: 'res-456' });
// Output: {..., "requestId": "abc-123", "resourceId": "res-456"}
```

## Using Loggers in Code

### 1. Request-Scoped Logger (Recommended)

Use the logger attached to the Hono context - it automatically includes the request ID:

```typescript
import { Context } from 'hono';

export async function createResource(c: Context) {
  const logger = c.get('logger');

  logger.info('Creating resource', {
    userId: c.get('user').id,
    resourceType: 'document'
  });

  try {
    const resource = await store.save(data);
    logger.info('Resource created successfully', {
      resourceId: resource.id
    });
    return c.json({ resource }, 201);
  } catch (error) {
    logger.error('Failed to create resource', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    throw error;
  }
}
```

### 2. Component Logger

For code outside request handlers (services, utilities):

```typescript
import { createComponentLogger } from './logger';

const logger = createComponentLogger('storage');

export class FileStore {
  async save(path: string, content: Buffer): Promise<void> {
    logger.debug('Saving file', { path, size: content.length });

    try {
      await fs.writeFile(path, content);
      logger.info('File saved successfully', { path });
    } catch (error) {
      logger.error('Failed to save file', {
        path,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }
}
```

### 3. Child Logger with Custom Context

For adding additional context to an existing logger:

```typescript
import { createChildLogger } from './logger';

const logger = createChildLogger({
  userId: 'user-123',
  sessionId: 'session-456'
});

logger.info('User action', { action: 'login' });
// Includes userId and sessionId in all logs
```

### Best Practices

**DO**:
- Use request-scoped logger in route handlers
- Include relevant context (IDs, types, counts)
- Log errors with stack traces
- Use appropriate log levels
- Log business events (resource created, auth success)

**DON'T**:
- Log sensitive data (passwords, tokens, PII)
- Log at debug level in loops (creates noise)
- Re-throw errors without logging them first
- Use `console.log` (use logger instead)

## Log Output Examples

### Debugging a 401 Error

**Scenario**: User tries to create a resource but gets 401

```bash
# Start with debug logging
LOG_LEVEL=debug npm start
```

**Console output**:
```
2025-12-29 19:38:45 [INFO] Logger initialized {"level":"debug","format":"simple"}
2025-12-29 19:38:46 [HTTP] Incoming request {"method":"POST","path":"/api/resources","requestId":"abc-123"}
2025-12-29 19:38:46 [WARN] Authentication failed: Missing Authorization header {"type":"auth_failed","reason":"missing_header","requestId":"abc-123"}
2025-12-29 19:38:46 [HTTP] Outgoing response {"status":401,"duration":5,"requestId":"abc-123"}
```

**Diagnosis**: Client didn't send `Authorization: Bearer <token>` header

### Debugging a Storage Error

**Scenario**: Resource creation fails with 500

```bash
LOG_LEVEL=debug npm start
```

**Console output**:
```
2025-12-29 19:40:00 [HTTP] Incoming request {"method":"POST","path":"/api/resources","requestId":"def-456"}
2025-12-29 19:40:00 [DEBUG] Authentication successful {"userId":"user-123","requestId":"def-456"}
2025-12-29 19:40:00 [ERROR] Failed to save file {"path":"/data/resources/xyz.txt","error":"EACCES: permission denied","requestId":"def-456"}
2025-12-29 19:40:00 [ERROR] Unhandled error during request processing {"error":"EACCES: permission denied","stack":"...","requestId":"def-456"}
2025-12-29 19:40:00 [HTTP] Outgoing response {"status":500,"duration":50,"requestId":"def-456"}
```

**Diagnosis**: Backend doesn't have write permission to `/data/resources/`

### Production Monitoring

**Scenario**: Monitor auth failures in production

```bash
# Set to info level (don't need debug noise)
LOG_LEVEL=info npm start

# Filter logs for auth failures
tail -f logs/combined.log | jq 'select(.type == "auth_failed")'
```

**Output**:
```json
{"level":"warn","message":"Authentication failed: Invalid token","type":"auth_failed","reason":"invalid_token","error":"jwt expired","timestamp":"2025-12-29T19:45:00.000Z"}
{"level":"warn","message":"Authentication failed: Missing Authorization header","type":"auth_failed","reason":"missing_header","timestamp":"2025-12-29T19:45:05.000Z"}
```

## Troubleshooting

### No Logs Appearing

**Problem**: No log output when running server

**Solution**:
```bash
# Check LOG_LEVEL isn't set too high
LOG_LEVEL=debug npm start

# Verify logger is initialized
grep "Logger initialized" logs/combined.log
```

### Too Many Logs (Noise)

**Problem**: Debug logs flooding console

**Solution**:
```bash
# Use http or info level for normal operation
LOG_LEVEL=http npm start

# Only use debug when actively debugging
LOG_LEVEL=debug npm start
```

### Missing Request IDs

**Problem**: Logs don't include request IDs

**Solution**:
- Ensure `requestIdMiddleware` is applied before other middleware
- Check middleware order in `src/index.ts`
- Request ID should be first middleware after CORS/security

### Log File Not Created

**Problem**: `logs/combined.log` doesn't exist

**Solution**:
```bash
# Create logs directory
mkdir -p logs

# Check file transport is enabled (not in test mode)
echo $NODE_ENV  # Should not be 'test'

# File transport auto-creates files on first log
```

## Production Considerations

### Log Rotation

Winston doesn't include log rotation by default. For production:

```bash
# Install winston-daily-rotate-file
npm install winston-daily-rotate-file

# Update logger.ts to use rotating transport (future enhancement)
```

### Centralized Logging

For distributed systems, ship logs to aggregation service:

**Options**:
- **DataDog**: APM + log aggregation
- **Splunk**: Enterprise log management
- **CloudWatch**: AWS-native logging
- **Elasticsearch**: Self-hosted ELK stack

**Future Enhancement**: Custom Winston transports for remote logging (see BACKEND-LOGGING.md Phase 3)

### Log Retention

**Current**: Logs accumulate indefinitely in `logs/`

**Recommended**:
- Development: Keep last 7 days
- Production: Keep 30-90 days depending on compliance
- Use log rotation with automatic cleanup

### Security Considerations

**Never Log**:
- Passwords or password hashes
- JWT tokens or refresh tokens
- API keys or secrets
- Credit card numbers or PII
- Full user objects (log IDs only)

**Always Log**:
- Error messages and stack traces
- Request IDs for correlation
- User IDs (not names/emails unless necessary)
- Timestamps for all events
- Action types and outcomes

### Performance Impact

**Log Levels by Environment**:
- Development: `debug` (full visibility)
- Staging: `http` (request tracking)
- Production: `info` or `warn` (minimize I/O)

**Structured Logging**: JSON format enables:
- Fast parsing with `jq`/log aggregators
- Indexed search in DataDog/Splunk
- Machine-readable format for analysis

## Related Documentation

- **[BACKEND-LOGGING.md](../../../BACKEND-LOGGING.md)** - Full implementation plan with future phases
- **[Development Guide](./DEVELOPMENT.md)** - Local development setup
- **[Testing Guide](./TESTING.md)** - Testing patterns and best practices
- **[Deployment Guide](./DEPLOYMENT.md)** - Production deployment procedures

## Implementation Notes

**Current Status**: Phase 1 Complete ✅
- Core logger with environment config
- Request ID middleware with correlation
- Request/response logging
- Enhanced auth logging with failure reasons
- Error logging with stack traces

**Future Enhancements** (see BACKEND-LOGGING.md):
- Phase 2: Domain-specific logging (storage, services, routes)
- Phase 3: Log rotation and remote transports
- Phase 4: Metrics and distributed tracing

---

**Last Updated**: 2025-12-29
