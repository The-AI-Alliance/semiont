# Semiont architecture

How Semiont works inside: how it is organized and how the pieces communicate.

For the contract between the pieces (channels, flows, W3C compliance), see **[../protocol/](../protocol/)**.
For running a stack, see **[../operator/](../operator/)**.
For contributor workflow, see **[../contributor/](../contributor/)**.

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
| **[CONTAINER-TOPOLOGY.md](../operator/CONTAINER-TOPOLOGY.md)** | Multi-container deployment: how the seven Semiont containers (gateway, archivist, librarian, worker, smelter, weaver, browser) and the infrastructure containers (postgres, neo4j, qdrant, ollama, the OTel collector, jaeger, prometheus) fit together; the unified bus contract and `SemiontSession`; deployment platforms. *Diagrams: who talks to whom · what attaches to what.* |
| **[ANCHORING.md](ANCHORING.md)** | How an annotation knows *where* it points: the shared `AnchoredText` vocabulary, the `locate`/`textUnder` inverse pair, and the pipeline that gives a scanned page a coordinate map — derived once at ingest, stored, served behind the settle barrier, and read by the canvas. Why annotation targets are fixed at birth. |
| **[PACKAGE-ARCHITECTURE.md](PACKAGE-ARCHITECTURE.md)** | The workspace packages organized by layer (foundation → wire → SDK → AI → application logic), the actual `package.json` dependency graph, and the five architectural principles that govern dependency direction. *Diagram: layered package dependencies.* |
| **[RETRY-AND-DEADLINES.md](RETRY-AND-DEADLINES.md)** | How peers wait for each other: the four retry policies (who waits, for what, how long), which failures qualify, and the four-layer rule for where a retry belongs. Why a deadline and a retry are one contract, and why the budgets chain. |
| **[PROJECTION-PATTERN.md](PROJECTION-PATTERN.md)** | How the `__system__`-stream projections are written and read: pure reducers, an imperative shell around them, and the axiom catalog both keep. |
| **[FILESYSTEM.md](FILESYSTEM.md)** | Where a knowledge base's record lives on disk: the working tree, the event log under `.semiont/events/`, and what is derived from them and kept outside the tree. |

## Cross-references

- **[../protocol/](../protocol/)** — the eight flows, the event-bus protocol, the OpenAPI reference, the W3C compliance story.
- **[../../packages/README.md](../../packages/README.md)** — alphabetized inventory of all `@semiont/*` workspace packages with one-line descriptions.
- **[../contributor/](../contributor/README.md)** — codebase orientation for new contributors.
