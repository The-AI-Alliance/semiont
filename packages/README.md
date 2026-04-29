# @semiont Packages

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/branch/main/graph/badge.svg)](https://codecov.io/gh/The-AI-Alliance/semiont)

Modular packages for the Semiont platform. For the layered design, dependency graph, and architectural principles that organize them, see **[docs/system/PACKAGE-ARCHITECTURE.md](../docs/system/PACKAGE-ARCHITECTURE.md)**.

## Published Packages

| Package | Version | Source | Description |
| ------- | ------- | ------ | ----------- |
| [@semiont/api-client](https://www.npmjs.com/package/@semiont/api-client) | [![npm](https://img.shields.io/npm/v/@semiont/api-client)](https://www.npmjs.com/package/@semiont/api-client) | [api-client](./api-client/) | HTTP transport adapter — `HttpTransport` (REST + SSE), `HttpContentTransport` (binary I/O). Consumed by `@semiont/sdk` |
| [@semiont/content](https://www.npmjs.com/package/@semiont/content) | [![npm](https://img.shields.io/npm/v/@semiont/content)](https://www.npmjs.com/package/@semiont/content) | [content](./content/) | Content-addressed storage for resource representations (SHA-256, deduplicated) |
| [@semiont/core](https://www.npmjs.com/package/@semiont/core) | [![npm](https://img.shields.io/npm/v/@semiont/core)](https://www.npmjs.com/package/@semiont/core) | [core](./core/) | OpenAPI-generated types, branded IDs, EventBus + ITransport contract, event protocol, W3C / locale / text helpers, config loaders |
| [@semiont/event-sourcing](https://www.npmjs.com/package/@semiont/event-sourcing) | [![npm](https://img.shields.io/npm/v/@semiont/event-sourcing)](https://www.npmjs.com/package/@semiont/event-sourcing) | [event-sourcing](./event-sourcing/) | Event store, event bus, materialized views (filesystem-based) |
| [@semiont/graph](https://www.npmjs.com/package/@semiont/graph) | [![npm](https://img.shields.io/npm/v/@semiont/graph)](https://www.npmjs.com/package/@semiont/graph) | [graph](./graph/) | Graph database abstraction (Neo4j, Neptune, JanusGraph, in-memory) |
| [@semiont/inference](https://www.npmjs.com/package/@semiont/inference) | [![npm](https://img.shields.io/npm/v/@semiont/inference)](https://www.npmjs.com/package/@semiont/inference) | [inference](./inference/) | LLM abstraction — text generation, entity extraction, resource creation (Anthropic, Ollama) |
| [@semiont/jobs](https://www.npmjs.com/package/@semiont/jobs) | [![npm](https://img.shields.io/npm/v/@semiont/jobs)](https://www.npmjs.com/package/@semiont/jobs) | [jobs](./jobs/) | Filesystem-based job queue, the `worker-main` container entry point for `semiont-worker`, and the job-claim/job-queue worker adapters |
| [@semiont/make-meaning](https://www.npmjs.com/package/@semiont/make-meaning) | [![npm](https://img.shields.io/npm/v/@semiont/make-meaning)](https://www.npmjs.com/package/@semiont/make-meaning) | [make-meaning](./make-meaning/) | Knowledge-base actor implementations (Stower, Gatherer, Matcher, Browser, Smelter), the `smelter-main` container entry point for `semiont-smelter`, and the `startMakeMeaning()` infrastructure orchestrator |
| [@semiont/mcp-server](https://www.npmjs.com/package/@semiont/mcp-server) | - | [mcp-server](./mcp-server/) | Model Context Protocol server — exposes Semiont as an MCP tool for Claude Desktop and other MCP clients |
| [@semiont/observability](https://www.npmjs.com/package/@semiont/observability) | [![npm](https://img.shields.io/npm/v/@semiont/observability)](https://www.npmjs.com/package/@semiont/observability) | [observability](./observability/) | OpenTelemetry helpers — `withSpan`, traceparent inject/extract, Node + Web SDK init. No-op when no exporter is configured |
| [@semiont/ontology](https://www.npmjs.com/package/@semiont/ontology) | [![npm](https://img.shields.io/npm/v/@semiont/ontology)](https://www.npmjs.com/package/@semiont/ontology) | [ontology](./ontology/) | Entity types, tag schemas, W3C annotation vocabularies |
| [@semiont/react-ui](https://www.npmjs.com/package/@semiont/react-ui) | [![npm](https://img.shields.io/npm/v/@semiont/react-ui)](https://www.npmjs.com/package/@semiont/react-ui) | [react-ui](./react-ui/) | React components and hooks; `useViewModel` / `useObservable` adapters over the SDK's MVVM layer |
| [@semiont/sdk](https://www.npmjs.com/package/@semiont/sdk) | [![npm](https://img.shields.io/npm/v/@semiont/sdk)](https://www.npmjs.com/package/@semiont/sdk) | [sdk](./sdk/) | `SemiontClient`, verb-oriented namespaces, `SemiontSession` + `SemiontBrowser`, view-models (MVVM), `bus-request` + cache. Transport-agnostic — pair with `@semiont/api-client` (HTTP) or `@semiont/make-meaning` (in-process) |
| [@semiont/test-utils](https://www.npmjs.com/package/@semiont/test-utils) | - | [test-utils](./test-utils/) | Shared test utilities, mock factories, fixtures |
| [@semiont/vectors](https://www.npmjs.com/package/@semiont/vectors) | [![npm](https://img.shields.io/npm/v/@semiont/vectors)](https://www.npmjs.com/package/@semiont/vectors) | [vectors](./vectors/) | Vector storage (Qdrant + in-memory), embedding providers (Voyage, Ollama), chunking, semantic search |

## Getting Started

See [Package Development Guide](./docs/DEVELOPMENT.md) for detailed development instructions, guidelines, and philosophy.

## License

Apache-2.0

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md)
