# @semiont/api-client

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+api-client%22)
[![npm version](https://img.shields.io/npm/v/@semiont/api-client.svg)](https://www.npmjs.com/package/@semiont/api-client)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/api-client.svg)](https://www.npmjs.com/package/@semiont/api-client)
[![License](https://img.shields.io/npm/l/@semiont/api-client.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

TypeScript SDK for [Semiont](https://github.com/The-AI-Alliance/semiont) - a knowledge management system for semantic annotations, AI-powered entity detection, and collaborative document analysis.

## What is Semiont?

Semiont lets you:

- **Store and manage documents** (text, markdown, code)
- **Create semantic annotations** using W3C Web Annotation standard
- **Link and reference** between documents
- **Track provenance** with event sourcing
- **Collaborate in real-time** via SSE streams
- **Detect entities** using AI (people, organizations, concepts)
- **Retrieve context** for LLMs via graph traversal
- **Generate new documents** from annotations with AI

## Installation

Install the latest stable release from npm:

```bash
npm install @semiont/api-client
```

Or install the latest development build:

```bash
npm install @semiont/api-client@dev
```

**Prerequisites**: Semiont backend running. See [Running the Backend](../../apps/backend/README.md#quick-start) for setup.

## Quick Start

```typescript
import { SemiontApiClient, baseUrl, email, resourceUri } from '@semiont/api-client';

const client = new SemiontApiClient({
  baseUrl: baseUrl('http://localhost:4000'),
});

// Authenticate (local development mode)
await client.authenticateLocal(email('user@example.com'));

// Create a text document
const { resource } = await client.createResource({
  name: 'My Document',
  file: Buffer.from('The quick brown fox jumps over the lazy dog.'),
  format: 'text/plain',
  entityTypes: ['example']
});

console.log('Created resource:', resource['@id']);

// Detect entities with AI
const stream = client.sse.detectAnnotations(resourceUri(resource['@id']), {
  entityTypes: ['Animal', 'Color']
});

stream.onProgress((p) => console.log(`Scanning: ${p.currentEntityType}`));
stream.onComplete((result) => console.log(`Found ${result.foundCount} entities`));

// Get annotations
const annotations = await client.getResourceAnnotations(resourceUri(resource['@id']));
console.log('Annotations:', annotations.annotations.length);
```

## Logging

Enable logging to debug requests and monitor API usage:

```typescript
import { SemiontApiClient, Logger, baseUrl } from '@semiont/api-client';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.json(),
  transports: [new winston.transports.Console()]
});

const client = new SemiontApiClient({
  baseUrl: baseUrl('http://localhost:4000'),
  logger
});

// Now all HTTP requests and SSE streams will be logged
```

**What gets logged**: HTTP requests/responses, SSE stream lifecycle, individual events, and errors

**Security**: Authorization headers are never logged to prevent token leaks

📘 **[Complete Logging Guide](./docs/LOGGING.md)** - Logger setup, integration examples, structured metadata, troubleshooting

## Documentation

📚 **[Usage Guide](./docs/Usage.md)** - Authentication, resources, annotations, SSE streaming

📖 **[API Reference](./docs/API-Reference.md)** - Complete method documentation

🛠️ **[Utilities Guide](./docs/Utilities.md)** - Text encoding, fuzzy anchoring, SVG utilities

## Key Features

- **Type-safe** - Generated from OpenAPI spec with branded types
- **W3C compliant** - Web Annotation standard with fuzzy text matching
- **Real-time** - SSE streaming for long operations
- **Framework-agnostic** - Pure TypeScript utilities work everywhere
- **Character encoding** - Proper UTF-8, ISO-8859-1, Windows-1252 support

## Use Cases

- ✅ MCP servers and AI integrations
- ✅ Frontend applications (wrap with React hooks)
- ✅ CLI tools and automation scripts
- ✅ Third-party integrations

❌ **Not for backend internal code** - Use [`@semiont/core`](../core/) instead

## License

Apache-2.0
