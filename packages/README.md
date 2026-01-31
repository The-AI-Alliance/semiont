# @semiont Packages

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/branch/main/graph/badge.svg)](https://codecov.io/gh/The-AI-Alliance/semiont)

Modular packages for the Semiont platform, organized in a layered architecture from low-level primitives to high-level application logic.

## Architecture Overview

### Layered Dependency Graph

```mermaid
graph BT
    %% Layer 4: Application Consumers
    backend["apps/backend<br/><i>Hono API server</i>"]
    frontend["apps/frontend<br/><i>Next.js web app</i>"]
    cli["apps/cli<br/><i>Environment management</i>"]

    %% Layer 3: Application Logic
    meaning["@semiont/make-meaning<br/><b>startMakeMeaning()</b><br/><i>Infrastructure orchestrator</i><br/>EventStore, GraphDB, RepStore,<br/>InferenceClient, JobQueue, Workers"]
    react["@semiont/react-ui<br/><i>React components & hooks</i>"]

    %% Layer 2: AI & Infrastructure
    inference["@semiont/inference<br/><i>LLM abstraction</i>"]
    jobs["@semiont/jobs<br/><i>Job queue</i>"]
    graph_pkg["@semiont/graph<br/><i>Graph DB abstraction</i>"]
    event["@semiont/event-sourcing<br/><i>Event store & views</i>"]
    content["@semiont/content<br/><i>Content-addressed storage</i>"]

    %% Layer 1: Domain Primitives
    ontology["@semiont/ontology<br/><i>Entity schemas & W3C</i>"]

    %% Layer 0: Foundation
    api["@semiont/api-client<br/><i>OpenAPI types</i>"]
    core["@semiont/core<br/><i>Core types & utilities</i>"]

    %% Application dependencies
    backend --> meaning
    frontend --> react
    frontend --> api
    cli --> core

    %% Application logic dependencies
    meaning --> event
    meaning --> graph_pkg
    meaning --> content
    meaning --> ontology
    meaning --> inference
    meaning --> jobs
    react --> api
    react --> ontology

    %% Infrastructure dependencies
    inference --> core
    inference --> api
    jobs --> core
    jobs --> api
    graph_pkg --> core
    graph_pkg --> api
    graph_pkg --> ontology
    event --> core
    event --> api
    content --> core

    %% Domain dependencies
    ontology --> api

    %% Foundation dependencies
    api --> core

    %% Styling by layer
    classDef layer0 fill:#e1f5fe,stroke:#01579b,stroke-width:3px
    classDef layer1 fill:#f3e5f5,stroke:#4a148c,stroke-width:2px
    classDef layer2 fill:#fff3e0,stroke:#e65100,stroke-width:2px
    classDef layer3 fill:#ffe0b2,stroke:#e65100,stroke-width:3px
    classDef layer4 fill:#e8f5e9,stroke:#1b5e20,stroke-width:3px

    class core,api layer0
    class ontology,content,event,graph_pkg layer1
    class inference,jobs layer2
    class meaning,react layer3
    class backend,frontend,cli layer4
```

### Key Architectural Principles

1. **Single Orchestration Point**: `@semiont/make-meaning`'s `startMakeMeaning()` function is the **infrastructure owner** - it initializes and manages the lifecycle of ALL subsystems (EventStore, GraphDB, RepStore, InferenceClient, JobQueue, Workers, GraphConsumer)

2. **Strict API Boundary**: `apps/frontend` NEVER imports backend packages directly - only `@semiont/api-client` and `@semiont/react-ui`

3. **Layered Dependencies**: Packages can only depend on packages in lower layers (no circular dependencies)

4. **Dependency Injection**: Infrastructure components are created once by `startMakeMeaning()` and passed to all consumers via constructor injection or Hono context

5. **Platform Independence**: Foundation and domain packages work in both browser and Node.js (infrastructure packages are Node-only)

## Published Packages

| Package | Version | Source | Description |
| ------- | ------- | ------ | ----------- |
| [@semiont/api-client](https://www.npmjs.com/package/@semiont/api-client) | [![npm](https://img.shields.io/npm/v/@semiont/api-client)](https://www.npmjs.com/package/@semiont/api-client) | [api-client](./api-client/) | OpenAPI-generated types and API client |
| [@semiont/core](https://www.npmjs.com/package/@semiont/core) | [![npm](https://img.shields.io/npm/v/@semiont/core)](https://www.npmjs.com/package/@semiont/core) | [core](./core/) | Core types, utilities, and domain models (ResourceId, AnnotationId, config) |
| [@semiont/ontology](https://www.npmjs.com/package/@semiont/ontology) | [![npm](https://img.shields.io/npm/v/@semiont/ontology)](https://www.npmjs.com/package/@semiont/ontology) | [ontology](./ontology/) | Entity types, tag schemas, W3C annotation vocabularies |
| [@semiont/content](https://www.npmjs.com/package/@semiont/content) | [![npm](https://img.shields.io/npm/v/@semiont/content)](https://www.npmjs.com/package/@semiont/content) | [content](./content/) | Content-addressed storage using checksums |
| [@semiont/event-sourcing](https://www.npmjs.com/package/@semiont/event-sourcing) | [![npm](https://img.shields.io/npm/v/@semiont/event-sourcing)](https://www.npmjs.com/package/@semiont/event-sourcing) | [event-sourcing](./event-sourcing/) | Event store, event bus, view storage (filesystem-based) |
| [@semiont/graph](https://www.npmjs.com/package/@semiont/graph) | [![npm](https://img.shields.io/npm/v/@semiont/graph)](https://www.npmjs.com/package/@semiont/graph) | [graph](./graph/) | Graph database abstraction (Neo4j, Neptune, JanusGraph, in-memory) |
| [@semiont/inference](https://www.npmjs.com/package/@semiont/inference) | [![npm](https://img.shields.io/npm/v/@semiont/inference)](https://www.npmjs.com/package/@semiont/inference) | [inference](./inference/) | AI primitives: prompts, parsers, generateText (OpenAI, Claude, local LLMs) |
| [@semiont/jobs](https://www.npmjs.com/package/@semiont/jobs) | [![npm](https://img.shields.io/npm/v/@semiont/jobs)](https://www.npmjs.com/package/@semiont/jobs) | [jobs](./jobs/) | Filesystem-based job queue for long-running operations |
| [@semiont/make-meaning](https://www.npmjs.com/package/@semiont/make-meaning) | [![npm](https://img.shields.io/npm/v/@semiont/make-meaning)](https://www.npmjs.com/package/@semiont/make-meaning) | [make-meaning](./make-meaning/) | Context assembly, pattern detection, and reasoning APIs |
| [@semiont/react-ui](https://www.npmjs.com/package/@semiont/react-ui) | [![npm](https://img.shields.io/npm/v/@semiont/react-ui)](https://www.npmjs.com/package/@semiont/react-ui) | [react-ui](./react-ui/) | React components and hooks for Semiont UIs |
| [@semiont/cli](https://www.npmjs.com/package/@semiont/cli) | [![npm](https://img.shields.io/npm/v/@semiont/cli)](https://www.npmjs.com/package/@semiont/cli) | [cli](../apps/cli/) | Command-line interface for Semiont |
| [@semiont/test-utils](https://www.npmjs.com/package/@semiont/test-utils) | - | [test-utils](./test-utils/) | Shared test utilities, mock factories, fixtures |
| [@semiont/mcp-server](https://www.npmjs.com/package/@semiont/mcp-server) | - | [mcp-server](./mcp-server/) | Model Context Protocol server for Claude Desktop integration |

## Getting Started

See [Package Development Guide](./docs/DEVELOPMENT.md) for detailed development instructions, guidelines, and philosophy.

## License

Apache-2.0

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md)
