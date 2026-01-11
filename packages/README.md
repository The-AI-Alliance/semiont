# @semiont Packages

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/branch/main/graph/badge.svg)](https://codecov.io/gh/The-AI-Alliance/semiont)

Modular packages for the Semiont platform, organized in a layered architecture from low-level primitives to high-level application logic.

## Dependency Graph

```mermaid
graph BT
    core["@semiont/core"]
    api["@semiont/api-client"]
    ontology["@semiont/ontology"]
    content["@semiont/content"]
    event["@semiont/event-sourcing"]
    graph_pkg["@semiont/graph"]
    inference["@semiont/inference"]
    jobs["@semiont/jobs"]
    meaning["@semiont/make-meaning"]
    react["@semiont/react-ui"]
    backend["Backend workers"]

    api --> core
    ontology --> api
    content --> core
    event --> core
    event --> api
    graph_pkg --> core
    graph_pkg --> api
    graph_pkg --> ontology
    inference --> core
    inference --> api
    jobs --> core
    jobs --> api
    meaning --> inference
    meaning --> graph_pkg
    meaning --> ontology
    meaning --> content
    react --> api
    react --> ontology
    backend --> meaning

    classDef foundation fill:#e1f5fe,stroke:#01579b,stroke-width:2px
    classDef domain fill:#f3e5f5,stroke:#4a148c,stroke-width:2px
    classDef ai fill:#fff3e0,stroke:#e65100,stroke-width:2px
    classDef app fill:#e8f5e9,stroke:#1b5e20,stroke-width:2px
    classDef ui fill:#fce4ec,stroke:#880e4f,stroke-width:2px

    class core,api foundation
    class ontology,content,event,graph_pkg domain
    class inference,jobs,meaning ai
    class backend app
    class react ui
```

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
