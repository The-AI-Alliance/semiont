# @semiont/api-client

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

```bash
npm install @semiont/api-client
```

**Prerequisites**: Semiont backend running. See [Running the Backend](../../apps/backend/README.md#quick-start) for setup.

## Quick Start

```typescript
import { SemiontApiClient } from '@semiont/api-client';

const client = new SemiontApiClient({
  baseUrl: 'http://localhost:4000',
});

// Authenticate
await client.authenticateLocal('user@example.com', '123456');

// Create a text document
const textBlob = new Blob(['The quick brown fox jumps over the lazy dog.']);
const { resource } = await client.createResource({
  name: 'My Document',
  file: textBlob,
  format: 'text/plain',
  entityTypes: ['example']
});

// Detect entities with AI
const stream = client.sse.detectAnnotations(resource['@id'], {
  entityTypes: ['Animal', 'Color']
});

stream.onProgress((p) => console.log(`Scanning: ${p.currentEntityType}`));
stream.onComplete(() => console.log('Detection complete!'));

// Generate new document from annotation
const generation = client.sse.generateResourceFromAnnotation(annotationUri, {
  title: 'Analysis of the fox',
  prompt: 'Write a detailed analysis of this animal.'
});

generation.onProgress((p) => console.log(`Generating... ${p.percentage}%`));
generation.onComplete((result) => console.log('New document:', result.resourceId));
```

## Documentation

📚 **[Usage Guide](./docs/Usage.md)** - Authentication, resources, annotations, SSE streaming
📖 **[API Reference](./docs/API-Reference.md)** - Complete method documentation

## Key Features

- **Type-safe** - Generated from OpenAPI spec
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
