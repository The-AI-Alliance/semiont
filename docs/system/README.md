# Semiont System

This is the system-architecture persona's home in the docs tree. Read these to understand how Semiont is organized, how the pieces communicate, and how the platform deploys.

For protocol-level concerns (channels, flows, W3C compliance), see **[../protocol/](../protocol/)**.
For browser end-user concerns, see **[../browser/](../browser/)**.
For contributor workflow, see **[../development/](../development/)**.

## Architecture

Semiont transforms unstructured text into a queryable knowledge graph using W3C Web Annotations as the semantic layer. The architecture is organized around **actors** communicating through a central **event bus**. Every meaningful action is an event on the bus; an actor never knows who else is listening.

Three categories of actor:

1. **Intelligent actors** — humans or AI agents that read, interpret, and annotate content. They produce events that carry semantic intent (mark, browse, yield, match, bind, gather, beckon).
2. **The knowledge base** — a passive actor that listens to events and materializes durable state. It has no intelligence; it simply records what the intelligent actors decide.
3. **Content streams** — external sources that yield new resources into the system (uploads, web fetches, API ingestion).

The deeper story splits across the docs below — each focused on one diagram and one concern.

| Doc | What it covers |
|---|---|
| **[ACTOR-MODEL.md](ACTOR-MODEL.md)** | The actor topology, six actor categories (Reader, Analyst, Author, Marker, Generator, Linker), Feeder + content streams, and why human ↔ AI peer collaboration falls out of the design. *Diagram: actor topology.* |
| **[HUMAN-UI.md](HUMAN-UI.md)** | The Semiont Browser SPA — Vite + React, state-unit split, RxJS SDK client, multi-KB session model. How human actors connect to the bus. *Diagram: SPA architecture.* |
| **[KNOWLEDGE-SYSTEM.md](KNOWLEDGE-SYSTEM.md)** | The seven reactive KB actors — five access actors (Stower, Browser, Gatherer, Matcher, CloneTokenManager) and two projection pipelines (Weaver, Smelter) — that mediate every read and write to the knowledge base, plus the storage layout (event log, materialized views, content store, graph, vectors, anchored text). *Diagram: knowledge system.* |
| **[CONTAINER-TOPOLOGY.md](CONTAINER-TOPOLOGY.md)** | Multi-container deployment: how the seven Semiont containers (gateway, archivist, librarian, worker, smelter, weaver, browser) and the infrastructure containers (postgres, neo4j, qdrant, ollama, jaeger) fit together; the unified bus contract and `SemiontSession`; deployment platforms. *Diagrams: who talks to whom · what attaches to what.* |
| **[ANCHORING.md](ANCHORING.md)** | How an annotation knows *where* it points: the shared `AnchoredText` vocabulary, the `locate`/`textUnder` inverse pair, and the pipeline that gives a scanned page a coordinate map — derived once at ingest, stored, served behind the settle barrier, and read by the canvas. Why annotation targets are fixed at birth. |
| **[PACKAGE-ARCHITECTURE.md](PACKAGE-ARCHITECTURE.md)** | The workspace packages organized by layer (foundation → wire → SDK → AI → application logic), the actual `package.json` dependency graph, and the five architectural principles that govern dependency direction. *Diagram: layered package dependencies.* |

## Operations

Day-2 concerns — deploying, securing, observing, scaling, troubleshooting:

- **[administration/](administration/)** — `AUTHENTICATION.md`, `AUTHORIZATION` / RBAC, `SECURITY.md`, `DEPLOYMENT.md`, `CONFIGURATION.md`, `OBSERVABILITY.md`, `BACKUP.md`, `IMAGES.md`, `MAINTENANCE.md`, `SCALING.md`, `TROUBLESHOOTING.md`
- **[platforms/](platforms/)** — how stacks are run, and `AWS.md` for scheduling the images yourself
- **[services/](services/)** — service catalog: `OVERVIEW.md`, `SECRETS.md`

## Project layout & local-run

- **[PROJECT-LAYOUT.md](PROJECT-LAYOUT.md)** — `.semiont/config` and the project-anchor convention.
- **[LOCAL-GATEWAY.md](LOCAL-GATEWAY.md)** — running the full local stack with the `semiont` launcher: start, useradd, logs, status, stop.
- **[LOCAL-SEMIONT.md](LOCAL-SEMIONT.md)** — installing and running Semiont locally; per-platform local-network notes the browser container needs.

## Cross-references

- **[../protocol/](../protocol/)** — the eight flows, the event-bus protocol, the OpenAPI reference, the W3C compliance story, agent skills.
- **[../../packages/README.md](../../packages/README.md)** — alphabetized inventory of all `@semiont/*` workspace packages with one-line descriptions.
- **[../../CONTRIBUTING.md](../../CONTRIBUTING.md)** — branch/PR workflow, commit conventions.
- **[../development/](../development/README.md)** — codebase orientation for new contributors.
