# Architecture

Design principles and architectural decisions behind @semiont/content.

## Design Principles

### 1. The Working Tree Is the Source of Truth

File content lives in the project working tree — ordinary files at ordinary paths, browsable with ordinary tools. The store does not copy bytes into a private blob directory; it reads and writes the files users see.

```
my-project/                  ← project root
├── .semiont/                ← project config and event log
└── docs/
    └── overview.md          ← "file://docs/overview.md"
```

From [src/working-tree-store.ts](../src/working-tree-store.ts): `resolveUri()` maps `file://` URIs directly onto paths under the project root.

### 2. Identity by URI, Integrity by Checksum

Resources are identified by their `file://` URI, which is stable across content changes. Moves are explicit (`move()`) and tracked by events, not inferred. SHA-256 checksums are recorded on every write and verified on demand:

```typescript
// register() can verify a file hasn't changed since it was recorded
await store.register('file://docs/overview.md', expectedChecksum);
// throws ChecksumMismatchError on mismatch
```

This split matters: the event log references resources by URI (stable), while checksums detect divergence between the recorded state and the file on disk.

### 3. Two Write Paths

The store distinguishes who has the bytes:

- **`store(content, storageUri)`** — the caller provides content and the file may not exist yet. This is the API/GUI/AI path.
- **`register(storageUri, expectedChecksum?)`** — the file is already on disk (e.g. the user created it in their editor) and we just read, verify, and record it. This is the CLI path.

Both return the same `StoredResource` metadata, so downstream event creation is identical.

### 4. Git Integration, Opt-In and Per-Call Escapable

When the project sets `[git] sync = true` in `.semiont/config`, mutating operations keep the git index in sync:

| Operation | Git behavior |
|-----------|--------------|
| `store()`, `register()` | `git add` |
| `move()` | `git mv` |
| `remove()` | `git rm` (or `git rm --cached` with `keepFile`) |

Every method accepts `{ noGit: true }` for callers that manage staging themselves (e.g. bulk imports that stage once at the end). Without git sync, the store uses plain filesystem operations. Git commands run via `execFileSync` with argument arrays — no shell interpolation.

### 5. Framework Independence

The package has no dependencies on web frameworks or HTTP libraries. It depends on `@semiont/core` for the `SemiontProject` and `Logger` types and on `pdfjs-dist` for PDF parsing. It runs anywhere Node runs: backend, CLI, scripts, tests.

In production the store is instantiated once by [@semiont/make-meaning](../../make-meaning/)'s `createKnowledgeBase()` and shared via the `KnowledgeBase.content` field.

## PDF Text-Layer Extraction

The second half of the package extracts positioned text from native PDFs so annotations can be anchored to both character offsets and page geometry.

- [src/extract-pdf-text-layer.ts](../src/extract-pdf-text-layer.ts) walks every page with pdfjs-dist's `getTextContent()`, concatenating runs into a single reading-order `text` string and recording each run's `[start, end)` character range plus its PDF-point geometry. Scanned/image-only PDFs (no text items) return `null`.
- [src/locate.ts](../src/locate.ts) answers the reverse question: given a character span of `text`, which rectangles on which pages does it cover? Overlapping runs are grouped by page, then into lines (runs whose baselines are within 2pt), producing one bounding rectangle per line.

Server and browser split the coordinate work: everything here is in PDF point space with a bottom-left origin (the server has no canvas); the browser performs the Y-flip and scaling when rendering highlights. The shared `PdfCoordinate` type and the viewrect FragmentSelector codec live in `@semiont/core`.

## Separation of Concerns

```
┌──────────────────────────────────────┐
│            @semiont/content          │
│                                      │
│  WorkingTreeStore   PDF text layer   │
│  files + git index  extract + locate │
│                                      │
│  checksum utils     MIME extensions  │
└──────────────────────────────────────┘
        ▲
        │ instantiated by
┌──────────────────────────────────────┐
│        @semiont/make-meaning         │
│  createKnowledgeBase() → kb.content  │
│  events, views, graph, vectors       │
└──────────────────────────────────────┘
```

What this package deliberately does **not** do:

- **No event sourcing** — recording *that* a resource was created/moved/removed is the event store's job; this package only touches bytes.
- **No metadata persistence** — `StoredResource` is returned to the caller, who records it in events. The store keeps no database of its own.
- **No HTTP** — transport belongs to the backend and `@semiont/http-transport`.
