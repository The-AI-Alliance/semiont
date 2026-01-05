# @semiont Packages

This directory contains the modular packages that make up the Semiont platform. These packages follow a layered architecture, from low-level primitives to high-level application logic.

> **Note**: These packages are currently in active development and have not yet been published to npm. They are used internally via npm workspaces.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  Application Layer                                      │
│  apps/backend, apps/frontend                            │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│  Applied Meaning-Making                                 │
│  @semiont/make-meaning                                  │
│  Context assembly, detection, reasoning                 │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│  AI & Orchestration Layer                               │
│  @semiont/inference, @semiont/jobs                      │
│  Prompts, parsers, generateText, job workers            │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│  Domain & Infrastructure Layer                          │
│  @semiont/event-sourcing, @semiont/content,             │
│  @semiont/graph, @semiont/ontology                      │
│  Event streams, storage, graph database, schemas        │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│  Foundation Layer                                       │
│  @semiont/core, @semiont/api-client                     │
│  Core types, utilities, OpenAPI-generated types         │
└─────────────────────────────────────────────────────────┘
```

## Core Packages

### [@semiont/core](./core/)
**Core domain types and utilities**

Foundation package providing core types, utilities, and domain models for resources, annotations, and graph structures. Used by all other packages.

**Key exports:**
- `ResourceId`, `AnnotationId`, `UserId` - Branded types for type safety
- `EnvironmentConfig` - Configuration interface
- `resourceIdToURI()`, `annotationIdToURI()` - URI conversion utilities

**Used by:** All packages

---

### [@semiont/api-client](./api-client/)
**OpenAPI-generated types and API client**

Auto-generated TypeScript types and API client from the OpenAPI specification. Provides the single source of truth for API contracts between frontend and backend.

**Key exports:**
- `components['schemas']['Annotation']` - W3C Annotation type
- `components['schemas']['ResourceDescriptor']` - Resource metadata type
- `paths` - API endpoint types

**Generated from:** `specs/openapi.json`

**Used by:** Frontend, backend, all domain packages

---

## Domain & Infrastructure Packages

### [@semiont/event-sourcing](./event-sourcing/)
**Event sourcing infrastructure**

Event store, event bus, and view storage implementations. All state changes in Semiont flow through events, enabling audit trails, time travel, and distributed updates.

**Key exports:**
- `EventStore` - Append and read events
- `FilesystemViewStorage` - Query materialized views of resources and annotations
- Event types: `annotation.added`, `resource.created`, `job.started`, etc.

**Storage:** Filesystem-based (JSON files)

**Used by:** Backend, make-meaning

---

### [@semiont/content](./content/)
**Content-addressed storage**

Content-addressed storage for resource representations using checksums. Enables deduplication, caching, and immutable content retrieval.

**Key exports:**
- `FilesystemRepresentationStore` - Store and retrieve content by checksum
- Supports all media types (text, images, PDFs, etc.)

**Storage:** Filesystem with checksum-based paths

**Used by:** Backend, make-meaning

---

### [@semiont/graph](./graph/)
**Graph database abstraction**

Unified graph database interface with multiple backend implementations. Enables traversal, path finding, backlinks, and full-text search across resources.

**Key exports:**
- `getGraphDatabase()` - Factory for graph database instances
- Implementations: Neo4j, Neptune, JanusGraph, in-memory
- Operations: `getBacklinks()`, `findPath()`, `getResourceConnections()`, `searchResources()`

**Default:** Neo4j (configurable)

**Used by:** Make-meaning, backend

---

### [@semiont/ontology](./ontology/)
**Entity types and tag schemas**

Defines domain ontologies: entity types (Document, Person, Organization), tag schemas (IRAC, IMRAD, Toulmin), and W3C annotation vocabularies.

**Key exports:**
- `getTagSchema()` - Retrieve tag schema definitions
- Tag schemas: `irac`, `imrad`, `toulmin`, `five-paragraph-essay`
- W3C motivations: `commenting`, `highlighting`, `assessing`, `tagging`, `linking`

**Used by:** Inference, make-meaning, backend

---

## AI & Orchestration Packages

### [@semiont/inference](./inference/)
**AI inference primitives**

Low-level AI capabilities: prompt engineering, response parsing, and text generation abstraction. Encodes domain knowledge about annotation motivations.

**Key exports:**
- `generateText()` - LLM abstraction (supports OpenAI, Claude, local models)
- `MotivationPrompts` - Prompt builders for each annotation motivation
- `MotivationParsers` - Response parsers with offset validation
- Match types: `CommentMatch`, `HighlightMatch`, `AssessmentMatch`, `TagMatch`

**Providers:** OpenAI (default), Anthropic Claude, local LLMs

**Used by:** Make-meaning

---

### [@semiont/jobs](./jobs/)
**Job queue and worker infrastructure**

Filesystem-based job queue for long-running operations. Supports job lifecycle management, progress tracking, retries, and failure handling.

**Key exports:**
- `JobWorker` - Base class for job workers
- `createJob()`, `getJob()`, `listJobs()` - Job management
- Job types: `highlight-detection`, `comment-detection`, `assessment-detection`, `tag-detection`

**Storage:** Filesystem (`jobs/` directory)

**Used by:** Backend workers

---

## Applied Meaning-Making

### [@semiont/make-meaning](./make-meaning/)
**Context assembly, pattern detection, and reasoning**

High-level APIs for making meaning from resources. Assembles context from distributed storage, detects semantic patterns using AI, and navigates resource relationships.

**Key exports:**

**Context Assembly:**
- `ResourceContext.getResourceMetadata()` - Retrieve resource from view storage
- `ResourceContext.listResources()` - Query resources with filters
- `AnnotationContext.getResourceAnnotations()` - Get annotations organized by motivation
- `AnnotationContext.buildLLMContext()` - Build context for AI processing
- `GraphContext.getBacklinks()` - Find resources that reference this resource

**Pattern Detection:**
- `AnnotationDetection.detectComments()` - AI-powered comment detection
- `AnnotationDetection.detectHighlights()` - Find passages to highlight
- `AnnotationDetection.detectAssessments()` - Detect passages for evaluation
- `AnnotationDetection.detectTags()` - Extract structured tags using schemas

**Dependencies:** All domain/infrastructure packages + inference

**Used by:** Backend workers, future frontend integrations

---

## UI & Integration Packages

### [@semiont/react-ui](./react-ui/)
**React components and hooks**

React component library for building Semiont user interfaces. Provides hooks for API integration, resource providers, and UI components.

**Key exports:**
- `ResourceProvider` - Context provider for resource data
- `useAnnotations()` - Hook for annotation data
- UI components for displaying resources and annotations

**Dependencies:** @semiont/api-client, React

**Used by:** Frontend application

---

### [@semiont/mcp-server](./mcp-server/)
**Model Context Protocol server**

MCP server implementation for Semiont API integration. Enables Claude Desktop and other MCP clients to interact with Semiont resources and annotations.

**Key exports:**
- MCP server for Semiont API
- Tools for resource and annotation operations

**Protocol:** MCP (Model Context Protocol)

**Used by:** Claude Desktop, MCP clients

---

## Development Packages

### [@semiont/test-utils](./test-utils/)
**Shared test utilities**

Test utilities, mock factories, and fixtures for testing across packages. Provides consistent mocking patterns and test data.

**Key exports:**
- Mock factories for resources, annotations, events
- Test fixtures and sample data
- Vitest helpers

**Used by:** All package test suites

---

## Package Dependency Graph

```
@semiont/core
  └─ @semiont/api-client
      ├─ @semiont/event-sourcing
      ├─ @semiont/content
      ├─ @semiont/graph
      ├─ @semiont/ontology
      │   └─ @semiont/inference
      │       └─ @semiont/make-meaning
      │           ├─ Backend workers
      │           └─ (Future) Frontend integrations
      ├─ @semiont/jobs
      └─ @semiont/react-ui
```

## Development Workflow

### Building Packages

```bash
# Build all packages
npm run build

# Build specific package
cd packages/make-meaning
npm run build

# Watch mode for development
npm run build:watch
```

### Running Tests

```bash
# Run all tests
npm test

# Run tests for specific package
cd packages/make-meaning
npm test

# Watch mode
npm run test:watch
```

### Type Checking

```bash
# Type check all packages
npm run typecheck

# Type check specific package
cd packages/inference
npm run typecheck
```

### Adding Dependencies

When adding a new dependency to a package:

1. **Workspace dependency** (another @semiont package):
   ```json
   {
     "dependencies": {
       "@semiont/core": "*"
     }
   }
   ```

2. **External dependency**:
   ```bash
   cd packages/your-package
   npm install external-package
   ```

3. **Dev dependency**:
   ```bash
   cd packages/your-package
   npm install -D dev-package
   ```

## Package Guidelines

### Naming Conventions

- Package names: `@semiont/kebab-case`
- Exported classes: `PascalCase`
- Functions and methods: `camelCase`
- Types and interfaces: `PascalCase`

### File Structure

```
packages/your-package/
├── src/
│   ├── index.ts          # Public API exports
│   ├── your-class.ts     # Implementation
│   └── types.ts          # Internal types
├── __tests__/
│   └── your-class.test.ts
├── dist/                 # Built output (gitignored)
├── package.json
├── tsconfig.json
├── tsup.config.ts        # Build configuration
└── README.md
```

### Export Patterns

Always export from `src/index.ts`:

```typescript
// Export classes and functions
export { YourClass } from './your-class';
export { yourFunction } from './your-function';

// Export types
export type { YourType } from './types';

// Re-export from dependencies for convenience
export type { SomeType } from '@semiont/core';
```

### Documentation

Each package should have:

1. **README.md** with:
   - Package description
   - Installation (when published)
   - Quick start examples
   - API reference
   - Architecture notes

2. **Inline documentation**:
   - JSDoc comments on public APIs
   - File-level comments explaining purpose
   - Complex logic explained with comments

### Testing

- Use Vitest for all tests
- Mock external dependencies (filesystem, databases, AI APIs)
- Test public APIs, not implementation details
- Aim for high coverage of core functionality

## Creating a New Package

1. **Create directory structure**:
   ```bash
   mkdir -p packages/your-package/src packages/your-package/__tests__
   ```

2. **Initialize package.json**:
   ```json
   {
     "name": "@semiont/your-package",
     "version": "0.1.0",
     "type": "module",
     "description": "Your package description",
     "main": "./dist/index.js",
     "types": "./dist/index.d.ts",
     "exports": {
       ".": {
         "types": "./dist/index.d.ts",
         "import": "./dist/index.js"
       }
     },
     "scripts": {
       "build": "npm run typecheck && tsup",
       "typecheck": "tsc --noEmit",
       "test": "vitest run",
       "clean": "rm -rf dist"
     }
   }
   ```

3. **Add tsconfig.json** (extend from workspace root)

4. **Add tsup.config.ts** for build configuration

5. **Add to workspace** in root `package.json`:
   ```json
   {
     "workspaces": [
       "packages/*"
     ]
   }
   ```

6. **Write documentation** (README.md)

7. **Add tests** (__tests__/)

## Philosophy

### Clean, Direct Code

- **No aliasing or wrappers** - If something is wrong, fix it directly
- **No compatibility layers** - Update all call sites when APIs change
- **Delete cruft immediately** - Don't accumulate dead code
- **Fix types, don't cast** - TypeScript errors indicate misaligned types

### Separation of Concerns

Each package has a clear, focused responsibility:

- **@semiont/inference**: AI primitives only (prompts, parsers, generateText)
- **@semiont/make-meaning**: Applied meaning-making (context + detection)
- **Backend workers**: Job orchestration only (progress, events, annotation creation)

### Event-Driven Architecture

- All state changes flow through events
- Views are materialized from event streams
- Enables audit trails, time travel, distributed updates

### Content-Addressed Storage

- Resources stored by content checksum
- Enables deduplication and immutable retrieval
- Separation of metadata (events) and content (files)

## License

Apache-2.0

## Contributing

See the main repository [CONTRIBUTING.md](../CONTRIBUTING.md) for guidelines.
