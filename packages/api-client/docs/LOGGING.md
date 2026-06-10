# API Client Logging

Complete guide to logging and observability in the Semiont API client transport.

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

The `HttpTransport` in `@semiont/api-client` provides optional logging support to help you:

- **Debug authentication issues** - See whether a token is being sent
- **Monitor API usage** - Track all HTTP requests and responses
- **Diagnose errors** - Get full context for failures
- **Integrate with monitoring** - Send logs to your observability platform

**Key features**:

- ✅ Framework-agnostic logger interface (winston, pino, bunyan, console)
- ✅ Covers HTTP requests made by the transport (via ky)
- ✅ Structured metadata for easy parsing
- ✅ Security-first (auth tokens never logged)
- ✅ Optional — omit the `logger` and nothing is logged

## Quick Start

### Basic Setup

```typescript
import { HttpTransport } from '@semiont/api-client';
import type { Logger } from '@semiont/core';
import { baseUrl } from '@semiont/core';
import winston from 'winston';

// Create your logger
const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.json(),
  transports: [new winston.transports.Console()]
});

// Pass it to the transport
const transport = new HttpTransport({
  baseUrl: baseUrl('http://localhost:4000'),
  token$,
  logger
});

// Now all HTTP requests made by the transport will be logged automatically
```

### Console-Only Logging (Development)

```typescript
const consoleLogger: Logger = {
  debug: (msg, meta) => console.debug(msg, meta),
  info: (msg, meta) => console.info(msg, meta),
  warn: (msg, meta) => console.warn(msg, meta),
  error: (msg, meta) => console.error(msg, meta),
  child: () => consoleLogger
};

const transport = new HttpTransport({
  baseUrl: baseUrl('http://localhost:4000'),
  token$,
  logger: consoleLogger
});
```

## Logger Interface

The transport accepts any object implementing the `Logger` interface from `@semiont/core`:

```typescript
interface Logger {
  debug(message: string, meta?: any): void;
  info(message: string, meta?: any): void;
  warn(message: string, meta?: any): void;
  error(message: string, meta?: any): void;
  child(meta: Record<string, any>): Logger;
}
```

**Compatible loggers**:

- [winston](https://github.com/winstonjs/winston)
- [pino](https://github.com/pinojs/pino)
- [bunyan](https://github.com/trentm/node-bunyan)
- console (for development)
- Any custom logger matching the interface

## What Gets Logged

The transport logs activity from its **HTTP client (via ky)** — every request, response, and error that crosses the wire:

```typescript
// Uploading a resource through the SDK triggers transport logging
const upload = client.yield.resource({
  name: 'My Document',
  content: Buffer.from('Hello World'),
  contentType: 'text/plain',
  entityTypes: ['example']
});

// Logs:
// DEBUG: HTTP Request { type: 'http_request', url: '...', method: 'POST', ... }
// DEBUG: HTTP Response { type: 'http_response', status: 201, ... }
```

Binary uploads through `HttpContentTransport.putBinary(...)` go through the same
ky instance and are logged the same way.

## Log Levels

The transport uses the four standard log levels; only `debug` and `error` are emitted today:

### debug - Verbose Request/Response Details

**What**: Every HTTP request and response
**When**: Development, troubleshooting specific issues
**Volume**: High (can be very noisy)

```typescript
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
```

### info - Significant Operations

**What**: Reserved for significant operations
**When**: Not currently emitted by the transport
**Volume**: None today

### warn - Recoverable Issues

**What**: Issues that don't prevent operation (not currently used by the transport)
**When**: Future use for retries, deprecation warnings
**Volume**: Low

### error - Failures

**What**: HTTP errors (4xx/5xx)
**When**: Always (you want to know about these)
**Volume**: Should be low in healthy systems

```typescript
logger.error('HTTP Request Failed', {
  type: 'http_error',
  url: 'http://localhost:4000/api/resources/999',
  method: 'GET',
  status: 404,
  statusText: 'Not Found',
  error: 'Resource not found'
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

const transport = new HttpTransport({ baseUrl: baseUrl(url), token$, logger });
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

const transport = new HttpTransport({ baseUrl: baseUrl(url), token$, logger });
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

const transport = new HttpTransport({ baseUrl: baseUrl(url), token$, logger });
```

### Filtering by Type

Only log errors and responses, dropping request noise:

```typescript
const logger: Logger = {
  debug: (msg: string, meta: any) => {
    // Only log responses, not requests
    if (meta.type === 'http_response') {
      console.debug(msg, meta);
    }
  },
  info: (msg: string, meta: any) => console.info(msg, meta),
  warn: (msg: string, meta: any) => console.warn(msg, meta),
  error: (msg: string, meta: any) => console.error(msg, meta),
  child: () => logger
};

const transport = new HttpTransport({ baseUrl: baseUrl(url), token$, logger });
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

const transport = new HttpTransport({ baseUrl: baseUrl(url), token$, logger });
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

const logger: Logger = {
  debug: (msg: string, meta: any) => splunkLogger.send({ message: msg, severity: 'debug', ...meta }),
  info: (msg: string, meta: any) => splunkLogger.send({ message: msg, severity: 'info', ...meta }),
  warn: (msg: string, meta: any) => splunkLogger.send({ message: msg, severity: 'warning', ...meta }),
  error: (msg: string, meta: any) => splunkLogger.send({ message: msg, severity: 'error', ...meta }),
  child: () => logger
};

const transport = new HttpTransport({ baseUrl: baseUrl(url), token$, logger });
```

## Structured Metadata

All log entries include a `type` field for easy filtering and parsing:

### HTTP Types

| Type | Level | Description |
|------|-------|-------------|
| `http_request` | debug | HTTP request initiated |
| `http_response` | debug | HTTP response received |
| `http_error` | error | HTTP request failed |

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

## Security

### Authorization Headers Are Never Logged

The transport **never** logs the value of `Authorization` headers to prevent token leakage:

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

The transport does not log request or response bodies, which may contain:

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
const transport = new HttpTransport({
  baseUrl: baseUrl(url),
  token$,
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
const logger: Logger = {
  debug: () => {}, // Ignore all debug logs (drops http_request/http_response)
  info: console.info,
  warn: console.warn,
  error: console.error,
  child: () => logger
};
```

### "Want to see request/response timing"

The transport logs `timestamp` on requests. Calculate duration yourself:

```typescript
const timings = new Map<string, number>();

const logger: Logger = {
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
  error: console.error,
  child: () => logger
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
   - Set up alerts for the `http_error` type
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

- [API Reference](./API-Reference.md) - Transport-level reference (`HttpTransport`, `HttpContentTransport`)
- `@semiont/sdk` - Complete high-level method catalog (`SemiontClient` and its namespaces)
