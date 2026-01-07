# @semiont Packages

Modular packages for the Semiont platform, organized in a layered architecture from low-level primitives to high-level application logic.

## Published Packages

[![npm version](https://img.shields.io/npm/v/@semiont/api-client)](https://www.npmjs.com/package/@semiont/api-client)
[![npm version](https://img.shields.io/npm/v/@semiont/core)](https://www.npmjs.com/package/@semiont/core)
[![npm version](https://img.shields.io/npm/v/@semiont/ontology)](https://www.npmjs.com/package/@semiont/ontology)
[![npm version](https://img.shields.io/npm/v/@semiont/event-sourcing)](https://www.npmjs.com/package/@semiont/event-sourcing)
[![npm version](https://img.shields.io/npm/v/@semiont/graph)](https://www.npmjs.com/package/@semiont/graph)
[![npm version](https://img.shields.io/npm/v/@semiont/inference)](https://www.npmjs.com/package/@semiont/inference)
[![npm version](https://img.shields.io/npm/v/@semiont/jobs)](https://www.npmjs.com/package/@semiont/jobs)
[![npm version](https://img.shields.io/npm/v/@semiont/make-meaning)](https://www.npmjs.com/package/@semiont/make-meaning)
[![npm version](https://img.shields.io/npm/v/@semiont/react-ui)](https://www.npmjs.com/package/@semiont/react-ui)
[![npm version](https://img.shields.io/npm/v/@semiont/cli)](https://www.npmjs.com/package/@semiont/cli)

## Architecture

```
┌─────────────────────────────────────────┐
│  Applications                           │
│  apps/backend, apps/frontend            │
└─────────────────────────────────────────┘
                   ↓
┌─────────────────────────────────────────┐
│  Applied Meaning-Making                 │
│  @semiont/make-meaning                  │
└─────────────────────────────────────────┘
                   ↓
┌─────────────────────────────────────────┐
│  AI & Orchestration                     │
│  @semiont/inference, @semiont/jobs      │
└─────────────────────────────────────────┘
                   ↓
┌─────────────────────────────────────────┐
│  Domain & Infrastructure                │
│  @semiont/event-sourcing, @semiont/     │
│  content, @semiont/graph, @semiont/     │
│  ontology                               │
└─────────────────────────────────────────┘
                   ↓
┌─────────────────────────────────────────┐
│  Foundation                             │
│  @semiont/core, @semiont/api-client     │
└─────────────────────────────────────────┘
```

## Package Overview

### Foundation Layer

- **[@semiont/core](./core/)** - Core types, utilities, and domain models (ResourceId, AnnotationId, config)
- **[@semiont/api-client](./api-client/)** - OpenAPI-generated types and API client

### Domain & Infrastructure

- **[@semiont/event-sourcing](./event-sourcing/)** - Event store, event bus, view storage (filesystem-based)
- **[@semiont/content](./content/)** - Content-addressed storage using checksums
- **[@semiont/graph](./graph/)** - Graph database abstraction (Neo4j, Neptune, JanusGraph, in-memory)
- **[@semiont/ontology](./ontology/)** - Entity types, tag schemas, W3C annotation vocabularies

### AI & Orchestration

- **[@semiont/inference](./inference/)** - AI primitives: prompts, parsers, generateText (OpenAI, Claude, local LLMs)
- **[@semiont/jobs](./jobs/)** - Filesystem-based job queue for long-running operations

### Applied Meaning-Making

- **[@semiont/make-meaning](./make-meaning/)** - Context assembly, pattern detection, reasoning APIs

### UI & Integration

- **[@semiont/react-ui](./react-ui/)** - React components and hooks for Semiont UIs
- **[@semiont/mcp-server](./mcp-server/)** - Model Context Protocol server for Claude Desktop integration

### Development

- **[@semiont/test-utils](./test-utils/)** - Shared test utilities, mock factories, fixtures

## Development

```bash
# Build all packages
npm run build

# Run all tests
npm test

# Type check all packages
npm run typecheck

# Build specific package
cd packages/your-package && npm run build

# Watch mode for development
npm run build:watch
```

## Creating a New Package

```bash
# 1. Create directory structure
mkdir -p packages/your-package/src packages/your-package/__tests__

# 2. Create package.json (see existing packages for template)

# 3. Add tsconfig.json, tsup.config.ts

# 4. Implement in src/index.ts

# 5. Add tests in __tests__/

# 6. Build and test
cd packages/your-package
npm run build
npm test
```

### Package Structure

```
packages/your-package/
├── src/
│   ├── index.ts          # Public API exports
│   └── *.ts              # Implementation
├── __tests__/
│   └── *.test.ts
├── dist/                 # Built output (gitignored)
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── README.md
```

### Guidelines

- **Package names**: `@semiont/kebab-case`
- **Exports**: Always export from `src/index.ts`
- **Dependencies**: Use workspace dependencies for `@semiont/*` packages (`"@semiont/core": "*"`)
- **Testing**: Use Vitest, mock external dependencies
- **Documentation**: JSDoc on public APIs, README with examples

## Philosophy

- **Clean, direct code** - Fix problems directly, no aliasing or compatibility layers
- **Separation of concerns** - Each package has a focused responsibility
- **Event-driven architecture** - All state changes flow through events
- **Content-addressed storage** - Resources stored by checksum for deduplication

## Dependency Graph

```
@semiont/core
  └─ @semiont/api-client
      ├─ @semiont/event-sourcing
      ├─ @semiont/content
      ├─ @semiont/graph
      ├─ @semiont/ontology
      │   └─ @semiont/inference
      │       └─ @semiont/make-meaning
      │           └─ Backend workers
      ├─ @semiont/jobs
      └─ @semiont/react-ui
```

## License

Apache-2.0

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md)
