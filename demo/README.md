# Semiont Demo Scripts

Demo scripts showcasing Semiont SDK and API functionality with modular, reusable components.

## Overview

Three demo scripts that demonstrate the Semiont platform:

1. **Prometheus Bound** (`pro_bo.ts`) - Classic literature from Project Gutenberg with paragraph-aware chunking
2. **FreeLaw NH** (`freelaw_nh.ts`) - Legal cases from Hugging Face datasets with metadata extraction
3. **Citizens United** (`citizens_united.ts`) - Supreme Court opinion from Cornell LII with simple chunking

All demos follow a similar 8-pass workflow: authenticate, fetch/download, process, upload, create ToC, stub annotations, link references, display history.

## Prerequisites

**⚠️ Requires running Semiont backend and frontend.**

1. **Start the backend** - See [Local Development Guide](../docs/LOCAL-DEVELOPMENT.md)
2. **Verify backend** at `http://localhost:4000`
3. **Verify frontend** at `http://localhost:3000` (optional, for viewing links)

**Requirements:**
- Node.js 18+ and npm
- Backend with `ENABLE_LOCAL_AUTH=true` (default in dev)
- A valid user account

## Installation

```bash
# From repository root
npm install

# Or from demo directory
cd demo
npm install
```

## Project Structure

```
demo/
├── src/                      # Reusable utility modules
│   ├── auth.ts              # Authentication helpers
│   ├── annotations.ts       # Annotation creation/linking
│   ├── chunking.ts          # Text chunking (simple & paragraph-aware)
│   ├── display.ts           # Console output formatting
│   ├── history.ts           # Event history display
│   ├── huggingface.ts       # Hugging Face dataset fetching
│   ├── legal-text.ts        # Cornell LII utilities
│   └── resources.ts         # Resource upload & ToC creation
├── pro_bo.ts                # Prometheus Bound demo
├── freelaw_nh.ts            # FreeLaw NH demo
├── citizens_united.ts       # Citizens United demo
└── package.json             # Scripts: pro-bo, freelaw-nh, citizens-united
```

## Usage

### 1. Prometheus Bound

Downloads "Prometheus Bound" from Project Gutenberg, chunks at paragraph boundaries (~4000 chars), creates 15 linked parts.

```bash
npm run pro-bo
```

### 2. FreeLaw NH

Fetches 4 New Hampshire Supreme Court cases from Hugging Face with citations and metadata.

```bash
npm run freelaw-nh
```

### 3. Citizens United

Downloads Citizens United v. FEC from Cornell LII, formats as markdown, chunks by size (~5000 chars), creates 5 linked parts.

```bash
npm run citizens-united
```

## Configuration

Create a `.env` file from the example:

```bash
cp .env.example .env
```

Edit `.env`:

```bash
# Backend API URL
BACKEND_URL=http://localhost:4000

# Frontend URL (for document links)
FRONTEND_URL=http://localhost:3000

# Authentication - use ONE of these:
AUTH_EMAIL=user@example.com
# ACCESS_TOKEN=your-jwt-token-here

# Data directory for filesystem inspection
DATA_DIR=/tmp/semiont/data/uploads
```

**Environment variables:**
- `BACKEND_URL` - Backend API (default: `http://localhost:4000`)
- `FRONTEND_URL` - Frontend URL (default: `http://localhost:3000`)
- `AUTH_EMAIL` - Auth email (default: `you@example.com`)
- `ACCESS_TOKEN` - JWT token (alternative to AUTH_EMAIL)
- `DATA_DIR` - Data directory (default: `/tmp/semiont/data/uploads`)

## Output Example

```
🎭 Prometheus Bound Demo
════════════════════════════════════════════════════════════

🔐 PASS 0: Authentication
   ✅ Authenticated successfully

📥 PASS 1: Download and Chunk Document
   ✅ Downloaded 264,795 characters
   ✅ Created 15 chunks (avg 3995 chars)

📤 PASS 2: Upload Document Chunks
   [1/15] Uploading Prometheus Bound - Part 1...
   ✅ http://localhost:4000/resources/a0b9710...

📑 PASS 3: Create Table of Contents
   ✅ Created ToC: http://localhost:4000/resources/ec7065bb...

🔗 PASS 4: Create Stub References
   [1/15] Creating annotation for "Part 1"...
   ✅ Annotation UFusvNvKZFRvTCFdZ1nYg

🎯 PASS 5: Link References to Documents
   ✅ Linked 15/15 references

📜 PASS 6: Document History
   Total events: 31 (1 created, 15 added, 15 updated)

✨ PASS 7: Results
   📋 Table of Contents: http://localhost:3000/en/know/resource/ec7065bb...
   📚 15 chunks created and linked

✅ Complete!
```

## Features Demonstrated

**Core SDK:**

- Type-safe API with `@semiont/api-client`
- W3C Web Annotations (TextPositionSelector)
- Modular, reusable components

**Event-Sourced Architecture:**

- Layer 1 (Storage): Raw content with hash-based sharding
- Layer 2 (Events): Append-only event logs
- Layer 3 (Projections): Consolidated JSON with annotations

**Annotation Workflow:**

- Stub references (annotations without targets)
- Linking via `updateAnnotationBody`
- Full URIs for resources and annotations

**Content Processing:**

- Multiple sources (Gutenberg, Hugging Face, Cornell LII)
- Flexible chunking (paragraph-aware or simple by size)
- Metadata extraction (citations, dates, docket numbers)

## API Client Usage

```typescript
import { SemiontApiClient, baseUrl } from '@semiont/api-client';

const client = new SemiontApiClient({ baseUrl: baseUrl(BACKEND_URL) });

// Authenticate
await client.authenticateLocal(email(AUTH_EMAIL));

// Create resource
const response = await client.createResource({
  name: 'Document',
  file: Buffer.from(content),
  format: 'text/plain',
  entityTypes: ['literature'],
});

// Create annotation
await client.createAnnotation(resourceUri, {
  motivation: 'linking',
  target: { source: resourceUri, selector: { type: 'TextPositionSelector', exact: 'text', start: 0, end: 4 }},
  body: [],
});

// Link reference
await client.updateAnnotationBody(annotationUri, {
  resourceId: 'id',
  operations: [{ op: 'add', item: { type: 'SpecificResource', source: targetUri, purpose: 'linking' }}],
});
```

## Troubleshooting

**"User not found"** - Email doesn't exist; create account via frontend or use different email

**"Local authentication not enabled"** - Backend needs `ENABLE_LOCAL_AUTH=true` in `.env`

**"401 Unauthorized"** - Token expired (8hr lifetime); re-run script for fresh token

**"404 Not Found" on annotations** - Ensure proper resource URI formatting from API responses

## Extending

The modular structure makes it easy to add new data sources:

```typescript
// src/arxiv.ts
export async function downloadArxivPaper(arxivId: string): Promise<string> { ... }

// arxiv_demo.ts
import { downloadArxivPaper } from './src/arxiv';
import { chunkBySize } from './src/chunking';
import { uploadChunks, createTableOfContents } from './src/resources';
// ... workflow
```

## Related Documentation

- [Local Development Guide](../docs/LOCAL-DEVELOPMENT.md) - Backend setup
- [Backend README](../apps/backend/README.md) - API documentation
- [API Client Package](../packages/api-client/README.md) - Client reference

## License

Apache-2.0
