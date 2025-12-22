# Semiont Demo

Configuration-driven demonstration of Semiont SDK features: document processing, chunking, annotations, and validation.

## Try in Codespaces

Launch a complete demo environment with one click (no installation required):

[![Open Demo in Codespaces](https://github.com/codespaces/badge.svg)](https://github.com/codespaces/new/The-AI-Alliance/semiont?devcontainer_path=demo%2F.devcontainer%2Fdevcontainer.json)

Includes:

- Semiont frontend, backend, and database (all pre-configured)
- Demo account with sample data
- Interactive terminal UI
- Ready to run in ~2 minutes

See [.devcontainer/README.md](.devcontainer/README.md) for details.

## Quick Start

```bash
# Run in interactive terminal UI mode
npm run demo:interactive

# Or run specific commands via CLI
npx tsx demo.ts <dataset> <command>

# Example: Download and process Citizens United case
npx tsx demo.ts citizens_united download
npx tsx demo.ts citizens_united load
npx tsx demo.ts citizens_united annotate
```

## Prerequisites

### Running Backend Required

1. Start backend (see [Local Development Guide](../docs/LOCAL-DEVELOPMENT.md))
2. Verify backend at `http://localhost:4000`
3. Create user account (via frontend or local auth)

**Requirements:**

- Node.js 18+
- Backend with `ENABLE_LOCAL_AUTH=true` (default in dev)
- Valid user account

## Modes

### Interactive Terminal UI

```bash
npm run demo:interactive
```

Full-screen terminal interface with three panels:

- **Left**: Dataset list with command tree
- **Bottom**: Detail view (config/status)
- **Right**: Activity log (command output)

**Controls:** `↑/↓` or `j/k` (navigate), `Enter` (execute), `Tab` (cycle focus), `q` (quit)

See [INTERACTIVE.md](INTERACTIVE.md) for details.

### CLI Mode

```bash
npx tsx demo.ts <dataset> <command>
```

**Datasets:** `citizens_united`, `prometheus_bound`, `freelaw_nh`, `arxiv`, `hiking`, and private datasets in `config/private/`

**Commands:**

- `download` - Fetch content, cache in `data/tmp/`
- `load` - Process cache, upload to backend, create ToC
- `annotate` - Detect citations, create annotations
- `validate` - Fetch all resources, verify content, show checksums

## Configuration

```bash
cp .env.example .env
```

**Environment variables:**

```bash
BACKEND_URL=http://localhost:4000
FRONTEND_URL=http://localhost:3000
AUTH_EMAIL=you@example.com
DATA_DIR=./data/uploads
```

## Project Structure

```text
demo/
├── demo.ts                   # Main entry point
├── src/                      # Reusable modules
│   ├── auth.ts              # Authentication
│   ├── annotations.ts       # Annotation creation/linking
│   ├── chunking.ts          # Text chunking
│   ├── resources.ts         # Upload & ToC creation
│   ├── validation.ts        # Resource validation
│   └── terminal-app.ts      # Interactive UI
└── config/                   # Dataset configurations
    ├── types.ts             # Config type definitions
    ├── citizens_united/     # Each dataset has config.ts
    └── private/             # Private datasets (gitignored)
```

## Workflow

### Download Phase

1. Fetch from Cornell LII, arXiv, Hugging Face, etc.
2. Cache raw content in `data/tmp/<dataset>/`

### Load Phase

1. Read from local cache
2. Format and process text
3. Chunk document (if configured)
4. Upload chunks to backend
5. Create Table of Contents (if chunked)
6. Link ToC references to documents

### Annotate Phase

1. Detect patterns (e.g., legal citations)
2. Create annotations via API

### Validate Phase

1. Fetch all resources (ToC, chunks, documents)
2. Calculate SHA-256 checksums
3. Show media types and text previews

## Example Output

```text
📚 CITIZENS UNITED Demo
════════════════════════════════════════════

🔐 Authentication
   ✅ Authenticated as you@example.com

📥 Download
   ✅ Downloaded 123,456 characters

📤 Load
   ✅ Created 5 chunks (avg 24,691 chars)
   ✅ Created ToC with 5 references

🔍 Annotate
   ✅ Detected 23 legal citations

✓ Validate
   ✅ ToC: text/html [sha256:a1b2c3...]
   ✅ Chunk 1: text/markdown [sha256:d4e5f6...]

📋 Table of Contents:
   http://localhost:3000/en/know/resource/abc123...
```

## API Client Usage

```typescript
import { SemiontApiClient, baseUrl, resourceUri } from '@semiont/api-client';

const client = new SemiontApiClient({ baseUrl: baseUrl(BACKEND_URL) });

// Authenticate
await client.authenticateLocal(email(AUTH_EMAIL));

// Create resource
const { resource } = await client.createResource({
  name: 'Document',
  file: Buffer.from(content),
  format: 'text/plain',
  entityTypes: ['literature'],
});

// Create annotation
await client.createAnnotation(resourceUri, {
  motivation: 'linking',
  target: {
    source: resourceUri,
    selector: { type: 'TextPositionSelector', start: 0, end: 4 }
  },
  body: [],
});
```

## Adding Datasets

Create `config/<dataset>/config.ts`:

```typescript
import type { DatasetConfig } from '../types';

export const config: DatasetConfig = {
  name: 'My Dataset',
  entityType: 'article',
  source: {
    type: 'remote',
    url: 'https://example.com/data.txt',
  },
  chunking: { enabled: true, mode: 'simple', targetSize: 5000 },
  tableOfContents: { enabled: true, createLinks: true },
};
```

Then run:

```bash
npx tsx demo.ts my-dataset download
npx tsx demo.ts my-dataset load
```

See [config/README.md](config/README.md) for configuration options.

## Troubleshooting

**"User not found"** - Create account via frontend or use different email

**"Local authentication not enabled"** - Set `ENABLE_LOCAL_AUTH=true` in backend `.env`

**"401 Unauthorized"** - Token expired (8hr); re-run for fresh token

**"Dataset not found"** - Check dataset name matches directory in `config/`

## Related Documentation

- [Interactive UI Guide](INTERACTIVE.md) - Terminal UI details
- [Config Guide](config/README.md) - Dataset configuration
- [Local Development](../docs/LOCAL-DEVELOPMENT.md) - Backend setup
- [API Client](../packages/api-client/README.md) - Client reference

## License

Apache-2.0
