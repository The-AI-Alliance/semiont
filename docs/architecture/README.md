# Semiont architecture

How Semiont works inside: how it is organized and how the pieces communicate. Read it to understand why Semiont behaves as it does; a contributor will want all of it.

For the contract between the pieces (channels, flows, W3C compliance), see **[../protocol/](../protocol/)**.
For running a stack, see **[../operator/](../operator/)**.
For contributor workflow, see **[../contributor/](../contributor/)**.

Semiont transforms unstructured text into a queryable knowledge graph using W3C Web Annotations as the semantic layer. The architecture is organized around **actors** communicating through a central **event bus**. Every meaningful action is an event on the bus; an actor never knows who else is listening. Humans and AI agents are the same kind of actor, and the knowledge base records what they decide.

Start with the actor model, then the knowledge system. The rest can be read in any order.

| Doc | What it covers |
|---|---|
| **[ACTOR-MODEL.md](ACTOR-MODEL.md)** | The actor topology: the six intelligent actors (Reader, Analyst, Author, Marker, Generator, Linker), the knowledge base they act on, how content enters, and why human ↔ AI peer collaboration falls out of the design. *Diagram: actor topology.* |
| **[KNOWLEDGE-SYSTEM.md](KNOWLEDGE-SYSTEM.md)** | The seven reactive KB actors — five access actors (Stower, Browser, Gatherer, Matcher, CloneTokenManager) and two projection pipelines (Weaver, Smelter) — that mediate every read and write to the knowledge base, plus the stores (event log, materialized views, content, graph, vectors, anchored text). *Diagram: knowledge system.* |
| **[HUMAN-UI.md](HUMAN-UI.md)** | The Semiont Browser SPA — Vite + React, the state-unit split, the SDK client, the multi-KB session model. How human actors connect to the bus. *Diagram: SPA architecture.* |
| **[FILESYSTEM.md](FILESYSTEM.md)** | Where a knowledge base lives on disk: the working tree, the event log under `.semiont/events/`, what is derived from them and kept outside the tree, and which service rebuilds each derived store. |
| **[ANCHORING.md](ANCHORING.md)** | How an annotation knows *where* it points: the shared `AnchoredText` vocabulary, the `locate`/`textUnder` inverse pair, and the pipeline that gives a scanned page a coordinate map — derived once at ingest, stored, served behind the settle barrier, and read by the canvas. Why annotation targets are fixed at birth. |
| **[PROJECTION-PATTERN.md](PROJECTION-PATTERN.md)** | How the `__system__`-stream projections are written and read: pure reducers, an imperative shell around them, and the axiom catalog both keep. |
| **[RETRY-AND-DEADLINES.md](RETRY-AND-DEADLINES.md)** | How peers wait for each other: the four retry policies (who waits, for what, how long), which failures qualify, and the four-layer rule for where a retry belongs. Why a deadline and a retry are one contract, and why the budgets chain. |
| **[PACKAGE-ARCHITECTURE.md](PACKAGE-ARCHITECTURE.md)** | The npm packages by layer and the Rust crates, each with its real dependency graph; what each service image runs; and the principles that govern dependency direction. *Diagrams: npm packages, Rust crates.* |

How the actors are deployed is the operator's **[CONTAINER-TOPOLOGY.md](../operator/CONTAINER-TOPOLOGY.md)**: the seven service containers (gateway, dispatcher, archivist, librarian, worker, smelter, weaver), the Browser, and the infrastructure beside them (PostgreSQL, Neo4j, Qdrant, NATS, Keycloak, Ollama, and the telemetry containers).

## Cross-references

- **[../protocol/](../protocol/)** — the eight flows, the event-bus protocol, the OpenAPI reference, the W3C compliance story.
- **[../../packages/README.md](../../packages/README.md)** — alphabetized inventory of all `@semiont/*` workspace packages with one-line descriptions.
- **[../contributor/](../contributor/README.md)** — codebase orientation for new contributors.
