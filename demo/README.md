# Semiont Demo Scripts

Demo scripts showcasing Semiont SDK and API functionality.

## Prometheus Bound Demo (`pro_bo.ts`)

A comprehensive demonstration script that showcases the full capabilities of the Semiont platform by downloading the ancient Greek play "Prometheus Bound" by Aeschylus from Project Gutenberg, splitting it into manageable chunks, creating a table of contents with linked annotations, and displaying the complete event history.

### What It Does

The demo runs through 8 passes to demonstrate the event-sourced architecture:

**Pass 0: Authentication**
- Authenticates with the backend using local development auth (`/api/tokens/local`)
- Receives a JWT token for subsequent API calls

**Pass 1: Download and Chunk**
- Downloads "Prometheus Bound" from Project Gutenberg (265K characters)
- Extracts just the play content (60K characters)
- Splits into 15 chunks of ~4000 characters each at natural paragraph boundaries

**Pass 2: Upload Document Chunks**
- Uploads all 15 chunks as separate documents
- Each document gets a content-addressed ID (SHA-256 hash)
- Shows Layer 1 filesystem paths for each document

**Pass 3: Create Table of Contents**
- Creates a markdown document listing all 15 parts
- Includes timestamp to ensure unique document ID on each run
- Shows Layer 1 filesystem path

**Pass 4: Create Stub References**
- Creates 15 annotations (one per "Part X" reference in the ToC)
- Each annotation is a stub reference with `source: null`
- Uses W3C Web Annotation format (TextPositionSelector with exact text, offset, length)
- Shows Layer 2 (event log) and Layer 3 (projection) paths for each

**Pass 5: Link References to Documents**
- Links all 15 stub references to their target documents
- Adds SpecificResource body items via updateAnnotationBody operations
- Demonstrates immediate updates (no async delays needed)

**Pass 6: Show Document History**
- Fetches complete event history via `/api/documents/{id}/events` API
- Displays event breakdown by type (document.created, annotation.added, annotation.body.updated)
- Shows recent events with sequence numbers and details

**Pass 7: Print Results**
- Outputs clickable links to all documents (ToC and 15 parts)
- Provides summary statistics

### Prerequisites

**⚠️ This demo requires a running Semiont backend and frontend.**

Before running the demo, you must:

1. **Set up and start the Semiont backend** - See the [Local Development Guide](../docs/LOCAL-DEVELOPMENT.md) for complete setup instructions
2. **Verify the backend is running** at `http://localhost:4000` (or configure `BACKEND_URL`)
3. **Verify the frontend is running** at `http://localhost:3000` (optional, only needed for viewing document links)

**Setup Documentation:**
- [LOCAL-DEVELOPMENT.md](../docs/LOCAL-DEVELOPMENT.md) - Complete local development guide with backend setup
- [Backend README](../apps/backend/README.md) - Backend-specific configuration and commands

**Requirements:**
- Node.js 18+ and npm
- Backend with `ENABLE_LOCAL_AUTH=true` (enabled by default in development)
- A valid user account (default: `oss@pingel.org`)

### Installation

From the repository root:

```bash
# Install dependencies for the demo workspace
npm install

# Or install just the demo directory
cd demo
npm install
```

### Project Structure

```
demo/
├── src/                      # Reusable utility modules
│   ├── chunking.ts          # Text processing (download, extract, chunk)
│   ├── display.ts           # Console output formatting
│   └── filesystem-utils.ts  # Storage path helpers (educational)
├── pro_bo.ts                # Main demo script (entry point)
├── .env.example             # Environment variable template
├── package.json             # Dependencies and scripts
├── tsconfig.json            # TypeScript configuration
└── README.md                # This file
```

**Key files:**
- **`pro_bo.ts`** - Main entry point demonstrating the 8-pass workflow
- **`src/chunking.ts`** - Text processing utilities (download, extract, chunk with formatting preservation)
- **`src/display.ts`** - Console output helpers (progress, headers, results)
- **`src/filesystem-utils.ts`** - Storage layer path computation (for educational display only)
- **`.env.example`** - Template for configuring backend/frontend URLs and auth

**API Client Usage:**
The demo uses `@semiont/api-client` for API interaction:
```typescript
import { SemiontApiClient } from '@semiont/api-client';

const client = new SemiontApiClient({
  baseUrl: BACKEND_URL,
});

// Authenticate (multiple methods available)
await client.authenticateLocal(AUTH_EMAIL, AUTH_CODE);
// OR
client.setAccessToken(ACCESS_TOKEN);

// Create documents
const doc = await client.createDocument({ name, content, format, entityTypes });

// Create annotations
const annotation = await client.createAnnotation({ motivation, target, body });

// Update annotation body (link references)
await client.updateAnnotationBody(annotationId, {
  documentId,
  operations: [{ op: 'add', item: { type: 'SpecificResource', source: targetDocumentId, purpose: 'linking' } }]
});

// Get event history
const events = await client.getDocumentEvents(documentId);
```

The `SemiontApiClient` from `@semiont/api-client` provides:
- Type-safe API methods with full TypeScript support
- Built-in authentication (local, Google OAuth, refresh tokens)
- Automatic retry logic and error handling
- Framework-agnostic (works in Node.js, browser, or any JS environment)

### Usage

```bash
cd demo
npm run pro-bo
```

Or run directly with `tsx`:

```bash
cd demo
npx tsx pro_bo.ts
```

### Configuration

The script can be configured using environment variables via a `.env` file:

1. **Copy the example environment file:**
   ```bash
   cp .env.example .env
   ```

2. **Edit `.env` to customize settings:**
   ```bash
   # Backend API URL
   BACKEND_URL=http://localhost:4000

   # Frontend URL (for generating document links in output)
   FRONTEND_URL=http://localhost:3000

   # Authentication email for local development
   AUTH_EMAIL=oss@pingel.org

   # Data directory for filesystem inspection (educational purposes)
   DATA_DIR=/path/to/your/data/uploads
   ```

3. **Run the script** (it will automatically load `.env`):
   ```bash
   npm run pro-bo
   ```

**Alternative: Inline environment variables** (without `.env` file):
```bash
BACKEND_URL=http://localhost:4000 FRONTEND_URL=http://localhost:3000 npx tsx pro_bo.ts
```

**Available environment variables:**
- `BACKEND_URL` - Backend API URL (default: `http://localhost:4000`)
- `FRONTEND_URL` - Frontend URL for links (default: `http://localhost:3000`)
- `AUTH_EMAIL` - Authentication email (default: `oss@pingel.org`)
- `DATA_DIR` - Data directory for filesystem paths (default: auto-detected)

### Output

The script provides detailed progress output with unicode styling:

```
🎭 Prometheus Bound Demo
════════════════════════════════════════════════════════════

🔐 PASS 0: Authentication
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Authenticating as oss@pingel.org...
   ✅ Authenticated as Admin User (oss@pingel.org)

📥 PASS 1: Download and Chunk Document
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Downloading from Project Gutenberg...
   ✅ Downloaded 264,795 characters
   Extracting play text...
   ✅ Extracted play: 59,924 characters
   Chunking into ~4000 character segments...
   ✅ Created 15 chunks (avg 3995 chars)

📤 PASS 2: Upload Document Chunks
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   [1/15] Uploading Prometheus Bound - Part 1...
       ✅ doc-sha256:a0b9710894940bb80d1b361b5e73dc4ce6254fd6c6af189b7defb5138c522970
       📁 Layer 1: /path/to/data/uploads/documents/48/e2/doc-sha256:...
   ...

📑 PASS 3: Create Table of Contents
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Creating ToC document with 15 entries (2025-10-13T01:59:22.981Z)...
   ✅ Created ToC: doc-sha256:ec7065bb22513ef4f84b91ecfb167600ea64f699fdce8ae1c155eb9c42bb21eb
   📁 Layer 1: /path/to/data/uploads/documents/55/2c/doc-sha256:...

🔗 PASS 4: Create Stub References
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   [1/15] Creating annotation for "Part 1"...
       ✅ Annotation UFusvNvKZFRvTCFdZ1nYg
       📁 Layer 2 (event log): /path/to/data/uploads/events/shards/55/2c/documents/doc-sha256:...
       📁 Layer 3 (projection): /path/to/data/uploads/annotations/55/2c/doc-sha256:...
   ...

🎯 PASS 5: Link References to Documents
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   [1/15] Linking "Part 1" → doc-sha256:a0b971089...
       ✅ Linked
   ...
   ✅ Linked 15/15 references

📜 PASS 6: Document History
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Total events: 31

   Event breakdown:
     • document.created: 1
     • annotation.added: 15
     • annotation.body.updated: 15

   Recent events:
     [22] seq=22 - annotation.body.updated
         → Linked to: doc-sha256:826a907f0dcfc1110c90a49ac22fb...
     [23] seq=23 - annotation.body.updated
         → Linked to: doc-sha256:8e9e825ebe232e54c2aa959552cf4...
   ...

✨ PASS 7: Results
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📋 Table of Contents:
   http://localhost:3000/en/know/document/doc-sha256:...

📚 Document Chunks:
   Part 1: http://localhost:3000/en/know/document/doc-sha256:...
   Part 2: http://localhost:3000/en/know/document/doc-sha256:...
   ...

📊 Summary:
   Total chunks: 15
   Annotations created: 15
   Annotations linked: 15

✅ Complete!
════════════════════════════════════════════════════════════
```

### Features Demonstrated

#### Core SDK Features
- **Type Safety**: Uses `@semiont/core` types throughout for compile-time error detection
- **Annotation ID Utilities**: Uses `extractAnnotationId()` for display, `encodeAnnotationIdForUrl()` for API calls
- **W3C Web Annotations**: Proper TextPositionSelector with exact text, offset, and length
- **Content Addressing**: SHA-256-based document IDs ensure immutability

#### Authentication & API
- **Local Development Auth**: Demonstrates `/api/tokens/local` endpoint for dev environments
- **JWT Token Management**: Proper Bearer token usage in Authorization headers
- **RESTful API Patterns**: Shows proper HTTP methods (POST, PUT, DELETE, GET)
- **URL Encoding**: Proper handling of annotation IDs in URL paths (full URIs with special characters)

#### Event-Sourced Architecture
- **Layer 1 (Storage)**: Raw document content in `.dat` files with hash-based sharding
- **Layer 2 (Events)**: Append-only event logs in `.jsonl` files organized by document
- **Layer 3 (Projections)**: Consolidated JSON projections with all annotations
- **Event Types**: document.created, annotation.added, annotation.body.updated
- **Synchronous Updates**: Layer 3 projections update immediately (not async)

#### Annotation Lifecycle
- **Stub References**: Create annotations with empty body or tagging-only TextualBody items
- **Linking References**: Add SpecificResource to body array via updateAnnotationBody operations
- **Annotation IDs**: Full URIs like `http://localhost:4000/annotations/xyz123`
- **Layer 3 Matching**: API endpoints match against Layer 3 which stores full URIs

#### Advanced Features
- **Event History API**: `/api/documents/{id}/events` returns full event stream
- **Consistent Hashing**: Document sharding uses hash of document ID, not content hash
- **Markdown Support**: Table of Contents uses markdown syntax with ordered lists
- **Progress Tracking**: Detailed console output with emoji, unicode box drawing, counters

### Technical Details

**Entity Types**:
- Documents are tagged with `literature`, `ancient-greek-drama`, and `table-of-contents` entity types
- References are tagged with `part-reference` to distinguish them from other annotation types

**Chunk Size**:
Configured to approximately 4000 characters per chunk (2-3 printed pages). The chunking algorithm:
- Splits on paragraph boundaries (double newlines) for readability
- Handles very long sections by further splitting on sentences
- Maintains context by keeping related content together

**Annotation Offsets**:
Calculates exact character positions accounting for markdown list syntax:
```typescript
const listItem = `${index + 1}. ${partText}\n`;
const start = content.length + `${index + 1}. `.length;  // Skip list number
const end = start + partText.length;
```

**Authentication**:
Uses the `/api/tokens/local` endpoint which is only available when:
- Backend has `ENABLE_LOCAL_AUTH=true`
- Running in development mode (`NODE_ENV=development`)
- User exists in the database

**Filesystem Sharding**:
The demo shows the actual storage paths using consistent hashing:
```typescript
// Hash document ID to get shard buckets (65536 buckets = 4 hex digits)
const hash = hashToUint32(docId);
const shardId = hash % 65536;
const shardHex = shardId.toString(16).padStart(4, '0');
const [ab, cd] = [shardHex.substring(0, 2), shardHex.substring(2, 4)];
// Result: /documents/ab/cd/doc-sha256:...
```

### Key Learnings from Development

1. **Annotation IDs are Full URIs**: The API returns and expects full URLs like `http://localhost:4000/annotations/xyz`, not just the short ID `xyz`. Always URL-encode these when using in API paths.

2. **Layer 3 is Synchronous**: Despite initial assumptions, the Layer 3 projection updates are NOT asynchronous. They happen immediately when events are written to Layer 2.

3. **Event History Shows Evolution**: The `/events` endpoint reveals how documents evolve through their lifecycle - from creation to stub annotation to resolution.

4. **SDK Utilities Clarify Intent**: Helper functions like `extractAnnotationId()` and `encodeAnnotationIdForUrl()` make code more maintainable and document the API contract.

5. **Filesystem Inspection is for Debugging Only**: While the demo shows filesystem paths for educational purposes, production code should use API endpoints exclusively.

### Troubleshooting

**"Authentication failed: 400 Bad Request - User not found"**
- The specified email doesn't exist in the database
- Ensure the backend has been provisioned with seed data
- Try using `oss@pingel.org` which should exist in dev environments

**"Authentication failed: 403 Forbidden - Local authentication is not enabled"**
- Backend doesn't have `ENABLE_LOCAL_AUTH=true` in `.env`
- Or backend is not running in development mode

**"Failed to upload document: 401 Unauthorized"**
- Authentication token expired (tokens last 8 hours)
- Backend JWT_SECRET changed since authentication
- Try re-running the script to get a fresh token

**"DELETE /api/annotations/http://...annotations/xyz 404"**
- Annotation ID not properly URL-encoded
- Make sure to use `encodeURIComponent()` on full annotation URIs
- This was a bug fixed in the frontend `api-client.ts`

**"No events found for document"**
- Document was just created and events endpoint may be lagging
- Check that the document ID is correct and URL-encoded
- Verify backend event store is properly configured

### Extending the Script

The script can be easily modified to:
- Upload different texts from Project Gutenberg or other sources
- Adjust chunk sizes for different use cases (books, articles, code)
- Apply different entity types or metadata
- Process multiple documents in batch
- Create different types of annotations (highlights, tags, comments)
- Implement annotation search and filtering
- Build document graphs by linking related documents

### Related Files

- [pro_bo_v2.ts](./pro_bo_v2.ts) - Enhanced version with full event lifecycle (recommended)
- [pro_bo.ts](./pro_bo.ts) - Original simpler version (preserved for reference)
- [package.json](./package.json) - Demo workspace dependencies
- [tsconfig.json](./tsconfig.json) - TypeScript configuration
- [../packages/core](../packages/core) - Semiont SDK source code
- [../apps/backend/src/routes/documents/routes/events.ts](../apps/backend/src/routes/documents/routes/events.ts) - Events API endpoint
- [../apps/backend/src/routes/auth.ts](../apps/backend/src/routes/auth.ts) - Backend authentication routes

### API Client Features Used

The demo showcases the `SemiontApiClient` from `@semiont/api-client`:

- **Type-Safe Methods** - All API calls are fully typed
- **Built-in Authentication** - Multiple authentication methods (local, OAuth, tokens)
- **Error Handling** - Structured `APIError` responses
- **Automatic Retry** - Configurable retry logic with exponential backoff
- **Framework-Agnostic** - Works in Node.js, browser, or any JavaScript environment

### License

Apache-2.0
