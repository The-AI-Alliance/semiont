# @semiont/api-client

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

## Documentation

📚 **[Usage Guide](./docs/Usage.md)** - Authentication, resources, annotations, SSE streaming

📖 **[API Reference](./docs/API-Reference.md)** - Complete method documentation

## Key Features

- **Type-safe** - Generated from OpenAPI spec with branded types
- **W3C compliant** - Web Annotation standard
- **Real-time** - SSE streaming for long operations
- **Framework-agnostic** - Works everywhere JavaScript runs

## Use Cases

- ✅ MCP servers and AI integrations
- ✅ Frontend applications (wrap with React hooks)
- ✅ CLI tools and automation scripts
- ✅ Third-party integrations

❌ **Not for backend internal code** - Use [`@semiont/core`](../core/) instead

## License

Apache-2.0
