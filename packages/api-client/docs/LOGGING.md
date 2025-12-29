# API Client Logging

Complete guide to logging and observability in the Semiont API client.

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Logger Interface](#logger-interface)
- [What Gets Logged](#what-gets-logged)
- [Log Levels](#log-levels)
- [Integration Examples](#integration-examples)
- [Structured Metadata](#structured-metadata)
- [Security](#security)
- [Troubleshooting](#troubleshooting)

## Overview

The Semiont API client provides optional logging support to help you:

- **Debug authentication issues** - See exactly what tokens are being sent
- **Monitor API usage** - Track all HTTP requests and responses
- **Observe SSE streams** - Watch real-time events as they arrive
- **Diagnose errors** - Get full context for failures with stack traces
- **Integrate with monitoring** - Send logs to your observability platform

**Key features**:

- ✅ Framework-agnostic logger interface (winston, pino, bunyan, console)
- ✅ Covers both HTTP requests (via ky) and SSE streams (via native fetch)
- ✅ Structured metadata for easy parsing
- ✅ Security-first (auth tokens never logged)
- ✅ Optional and backward compatible

## Quick Start

### Basic Setup

```typescript
import { SemiontApiClient, Logger, baseUrl } from '@semiont/api-client';
import winston from 'winston';

// Create your logger
const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.json(),
  transports: [new winston.transports.Console()]
});

// Pass it to the client
const client = new SemiontApiClient({
  baseUrl: baseUrl('http://localhost:4000'),
  logger
});

// Now all HTTP requests and SSE streams will be logged automatically
```

### Console-Only Logging (Development)

```typescript
const client = new SemiontApiClient({
  baseUrl: baseUrl('http://localhost:4000'),
  logger: {
    debug: (msg, meta) => console.debug(msg, meta),
    info: (msg, meta) => console.info(msg, meta),
    warn: (msg, meta) => console.warn(msg, meta),
    error: (msg, meta) => console.error(msg, meta)
  }
});
```

## Logger Interface

The client accepts any object implementing this interface:

```typescript
interface Logger {
  debug(message: string, meta?: any): void;
  info(message: string, meta?: any): void;
  warn(message: string, meta?: any): void;
  error(message: string, meta?: any): void;
}
```

**Compatible loggers**:

- [winston](https://github.com/winstonjs/winston)
- [pino](https://github.com/pinojs/pino)
- [bunyan](https://github.com/trentm/node-bunyan)
- console (for development)
- Any custom logger matching the interface

## What Gets Logged

The API client logs activity from **two different HTTP clients**:

### 1. Regular HTTP Requests (via ky)

All resource, annotation, and authentication operations:

```typescript
// Creating a resource triggers logging
const { resource } = await client.createResource({
  name: 'My Document',
  file: Buffer.from('Hello World'),
  format: 'text/plain',
  entityTypes: ['example']
});

// Logs:
// DEBUG: HTTP Request { type: 'http_request', url: '...', method: 'POST', ... }
// DEBUG: HTTP Response { type: 'http_response', status: 201, ... }
```

### 2. SSE Streams (via native fetch)

All streaming operations for AI-powered detection and generation:

```typescript
const stream = client.sse.detectAnnotations(resourceUri(resource['@id']), {
  entityTypes: ['Person', 'Organization']
});

stream.onProgress((p) => console.log(p.message));
stream.onComplete((r) => console.log(`Found ${r.foundCount} entities`));

// Logs:
// DEBUG: SSE Stream Request { type: 'sse_request', url: '...', ... }
// INFO:  SSE Stream Connected { type: 'sse_connected', status: 200, ... }
// DEBUG: SSE Event Received { type: 'sse_event', event: 'detection-progress', ... }
// DEBUG: SSE Event Received { type: 'sse_event', event: 'detection-complete', ... }
// INFO:  SSE Stream Closed { type: 'sse_closed', reason: 'complete' }
```

## Log Levels

The client uses four log levels with specific meanings:

### debug - Verbose Request/Response Details

**What**: Every HTTP request, response, and SSE event
**When**: Development, troubleshooting specific issues
**Volume**: High (can be very noisy)

```typescript
// HTTP
logger.debug('HTTP Request', {
  type: 'http_request',
  url: 'http://localhost:4000/api/resources',
  method: 'POST',
  timestamp: 1234567890,
  hasAuth: true
});

logger.debug('HTTP Response', {
  type: 'http_response',
  url: 'http://localhost:4000/api/resources',
  method: 'POST',
  status: 201,
  statusText: 'Created'
});

// SSE
logger.debug('SSE Event Received', {
  type: 'sse_event',
  url: 'http://localhost:4000/resources/123/detect-annotations-stream',
  event: 'detection-progress',
  hasData: true
});
```

### info - Significant Operations

**What**: SSE stream lifecycle events, major operations
**When**: Production monitoring, understanding application flow
**Volume**: Medium

```typescript
logger.info('SSE Stream Connected', {
  type: 'sse_connected',
  url: 'http://localhost:4000/resources/123/detect-annotations-stream',
  status: 200,
  contentType: 'text/event-stream'
});

logger.info('SSE Stream Closed', {
  type: 'sse_closed',
  url: 'http://localhost:4000/resources/123/detect-annotations-stream',
  reason: 'complete' // or 'abort'
});
```

### warn - Recoverable Issues

**What**: Issues that don't prevent operation (not currently used by client)
**When**: Future use for retries, deprecation warnings
**Volume**: Low

### error - Failures

**What**: HTTP errors (4xx/5xx), SSE stream failures
**When**: Always (you want to know about these)
**Volume**: Should be low in healthy systems

```typescript
// HTTP error
logger.error('HTTP Request Failed', {
  type: 'http_error',
  url: 'http://localhost:4000/api/resources/999',
  method: 'GET',
  status: 404,
  statusText: 'Not Found',
  error: 'Resource not found'
});

// SSE error
logger.error('SSE Stream Error', {
  type: 'sse_error',
  url: 'http://localhost:4000/resources/123/detect-annotations-stream',
  error: 'Connection refused',
  phase: 'connect' // or 'stream' or 'parse'
});
```

## Integration Examples

### Winston (File + Console)

```typescript
import winston from 'winston';

const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    // Write all logs to console
    new winston.transports.Console({
      format: winston.format.simple()
    }),
    // Write all logs to file
    new winston.transports.File({ filename: 'semiont-api.log' }),
    // Write errors to separate file
    new winston.transports.File({ filename: 'semiont-errors.log', level: 'error' })
  ]
});

const client = new SemiontApiClient({ baseUrl, logger });
```

### Pino (High Performance)

```typescript
import pino from 'pino';

const logger = pino({
  level: 'debug',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true
    }
  }
});

const client = new SemiontApiClient({ baseUrl, logger });
```

### Environment-Based Levels

```typescript
import winston from 'winston';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info', // debug in dev, info in prod
  format: winston.format.json(),
  transports: [
    new winston.transports.Console()
  ]
});

const client = new SemiontApiClient({ baseUrl, logger });
```

### Filtering by Type

Only log errors and SSE lifecycle events:

```typescript
const logger = {
  debug: () => {}, // Ignore debug
  info: (msg: string, meta: any) => {
    // Only log SSE lifecycle
    if (meta.type === 'sse_connected' || meta.type === 'sse_closed') {
      console.info(msg, meta);
    }
  },
  warn: (msg: string, meta: any) => console.warn(msg, meta),
  error: (msg: string, meta: any) => console.error(msg, meta)
};

const client = new SemiontApiClient({ baseUrl, logger });
```

### Integration with Observability Platforms

#### DataDog

```typescript
import winston from 'winston';
import { datadogWinston } from 'datadog-winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new datadogWinston({
      apiKey: process.env.DATADOG_API_KEY!,
      service: 'semiont-client',
      ddsource: 'nodejs'
    })
  ]
});

const client = new SemiontApiClient({ baseUrl, logger });
```

#### Splunk

```typescript
import winston from 'winston';
import { SplunkStreamEvent } from 'splunk-logging';

const SplunkStream = require('splunk-logging').Logger;

const splunkLogger = new SplunkStream({
  token: process.env.SPLUNK_TOKEN,
  url: process.env.SPLUNK_URL
});

const logger = {
  debug: (msg: string, meta: any) => splunkLogger.send({ message: msg, severity: 'debug', ...meta }),
  info: (msg: string, meta: any) => splunkLogger.send({ message: msg, severity: 'info', ...meta }),
  warn: (msg: string, meta: any) => splunkLogger.send({ message: msg, severity: 'warning', ...meta }),
  error: (msg: string, meta: any) => splunkLogger.send({ message: msg, severity: 'error', ...meta })
};

const client = new SemiontApiClient({ baseUrl, logger });
```

## Structured Metadata

All log entries include a `type` field for easy filtering and parsing:

### HTTP Types

| Type | Level | Description |
|------|-------|-------------|
| `http_request` | debug | HTTP request initiated |
| `http_response` | debug | HTTP response received |
| `http_error` | error | HTTP request failed |

### SSE Types

| Type | Level | Description |
|------|-------|-------------|
| `sse_request` | debug | SSE stream request initiated |
| `sse_connected` | info | SSE stream connected successfully |
| `sse_event` | debug | SSE event received |
| `sse_closed` | info | SSE stream closed (normal) |
| `sse_error` | error | SSE stream error |

### Common Fields

**HTTP Request**:
```typescript
{
  type: 'http_request',
  url: string,              // Full URL
  method: string,           // GET, POST, etc.
  timestamp: number,        // Unix timestamp (ms)
  hasAuth: boolean          // Whether Authorization header is present
}
```

**HTTP Response**:
```typescript
{
  type: 'http_response',
  url: string,
  method: string,
  status: number,           // 200, 201, etc.
  statusText: string        // 'OK', 'Created', etc.
}
```

**HTTP Error**:
```typescript
{
  type: 'http_error',
  url: string,
  method: string,
  status: number,
  statusText: string,
  error: string             // Error message
}
```

**SSE Stream Connected**:
```typescript
{
  type: 'sse_connected',
  url: string,
  status: number,
  contentType: string       // 'text/event-stream'
}
```

**SSE Event**:
```typescript
{
  type: 'sse_event',
  url: string,
  event: string,            // Event type ('detection-progress', etc.)
  hasData: boolean
}
```

**SSE Stream Closed**:
```typescript
{
  type: 'sse_closed',
  url: string,
  reason: 'complete' | 'abort'
}
```

**SSE Error**:
```typescript
{
  type: 'sse_error',
  url: string,
  error: string,
  phase: 'connect' | 'stream' | 'parse',
  status?: number           // Only present in connect phase
}
```

## Security

### Authorization Headers Are Never Logged

The client **never** logs the value of `Authorization` headers to prevent token leakage:

```typescript
// ✅ What gets logged
{
  type: 'http_request',
  url: 'http://localhost:4000/api/resources',
  method: 'GET',
  hasAuth: true  // ← Only indicates presence, not value
}

// ❌ What does NOT get logged
{
  headers: {
    'Authorization': 'Bearer eyJhbGc...'  // ← Never included
  }
}
```

### Request/Response Bodies Not Logged

The client does not log request or response bodies, which may contain:

- User credentials
- Personally identifiable information (PII)
- Sensitive document content

Only metadata (URLs, methods, status codes) is logged.

### Safe for Production

The default logging configuration is safe for production use:

- ✅ No token values
- ✅ No request/response bodies
- ✅ No PII
- ✅ Only metadata and errors

## Troubleshooting

### "No logs appearing"

**Check logger is passed**:
```typescript
const client = new SemiontApiClient({
  baseUrl,
  logger // ← Make sure this is present
});
```

**Check log level**:
```typescript
// If logger level is 'info', you won't see HTTP requests (they're 'debug')
const logger = winston.createLogger({
  level: 'debug' // ← Lower to 'debug' to see all logs
});
```

### "Too many logs"

**Increase log level** to reduce volume:
```typescript
const logger = winston.createLogger({
  level: 'info' // ← Only info, warn, error (no debug)
});
```

**Filter by type**:
```typescript
const logger = {
  debug: () => {}, // Ignore all debug logs
  info: (msg: string, meta: any) => {
    // Only log SSE lifecycle
    if (meta.type?.startsWith('sse_')) {
      console.info(msg, meta);
    }
  },
  warn: console.warn,
  error: console.error
};
```

### "SSE events not logging"

SSE events are logged at `debug` level. Make sure your logger level is set to `debug`:

```typescript
const logger = winston.createLogger({
  level: 'debug' // ← Required to see SSE events
});
```

### "Want to see request/response timing"

The client logs `timestamp` on requests. Calculate duration yourself:

```typescript
const timings = new Map<string, number>();

const logger = {
  debug: (msg: string, meta: any) => {
    if (meta.type === 'http_request') {
      timings.set(meta.url, meta.timestamp);
    } else if (meta.type === 'http_response') {
      const start = timings.get(meta.url);
      if (start) {
        const duration = Date.now() - start;
        console.debug(`${meta.method} ${meta.url} - ${duration}ms`);
        timings.delete(meta.url);
      }
    }
  },
  info: console.info,
  warn: console.warn,
  error: console.error
};
```

## Best Practices

1. **Use environment-based log levels**
   - `debug` in development
   - `info` in production (unless debugging)
   - `error` for production error tracking

2. **Store logs persistently**
   - Use file transports or log aggregation services
   - Rotate logs to prevent disk filling
   - Keep error logs longer than info logs

3. **Monitor error logs**
   - Set up alerts for `http_error` and `sse_error` types
   - Track error rates over time
   - Investigate spikes in 4xx/5xx errors

4. **Filter strategically**
   - Use `type` field to filter log types
   - Consider URL patterns for filtering specific endpoints
   - Balance verbosity with usefulness

5. **Test your logging**
   - Verify logs appear in development
   - Test error scenarios to see error logs
   - Check log volume in production before full rollout

## Related Documentation

- [Usage Guide](./Usage.md) - General API client usage
- [API Reference](./API-Reference.md) - Complete method documentation
