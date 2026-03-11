# Architecture: Actor Model

The current architecture ([ARCHITECTURE.md](ARCHITECTURE.md)) describes Semiont as a layered system — client, application, data, compute. This document reframes the same system as a set of **actors** communicating through a central **event bus**. The shift in perspective clarifies what each participant *does* and *knows*, and makes it easier to reason about adding new actors (human or AI) without touching the plumbing.

## Core Insight

Every meaningful action in Semiont is an event on the bus. The actors fall into three categories:

1. **Intelligent actors** — humans or AI agents that read, interpret, and annotate content. They produce events that carry semantic intent (mark, browse, yield, bind, gather, beckon).
2. **The knowledge base** — a passive actor that listens to events and materializes durable state. It has no intelligence; it simply records what the intelligent actors decide.
3. **Content streams** — external sources that yield new resources into the system (uploads, web fetches, API ingestion).

The event bus is the only coupling between actors. An actor does not know who else is listening.

## Actor Topology

```mermaid
graph TD
    READER["Human Reader"] -->|"browse, beckon"| BUS
    ANALYST["Human Analyst"] -->|"mark, browse, bind"| BUS
    AUTHOR["Human Author"] -->|"yield, mark"| BUS
    MARKER["AI Marker"] -->|"mark, browse, beckon"| BUS
    GENERATOR["AI Generator"] -->|"yield, gather"| BUS
    LINKER["AI Linker"] -->|"bind, gather"| BUS

    BUS["E V E N T &ensp; B U S"]

    SOURCES["Content Sources"] -->|"yield"| BUS
    BUS -->|"events"| KB["Knowledge Base"]
    BUS -->|"gather"| GATHERER["Gatherer"]
    BUS -->|"bind"| BINDER["Binder"]
    SOURCES ~~~ GATHERER
    GATHERER -->|"query"| KB
    BINDER -->|"query"| KB

    classDef bus fill:#e8a838,stroke:#b07818,stroke-width:3px,color:#000,font-weight:bold,font-size:14px
    classDef human fill:#4a90a4,stroke:#2c5f7a,stroke-width:2px,color:#fff
    classDef ai fill:#5a9a6a,stroke:#3d6644,stroke-width:2px,color:#fff
    classDef kb fill:#8b6b9d,stroke:#6b4a7a,stroke-width:2px,color:#fff
    classDef stream fill:#c97d5d,stroke:#8b4513,stroke-width:2px,color:#fff
    classDef worker fill:#5a9a6a,stroke:#3d6644,stroke-width:2px,color:#fff

    class READER,ANALYST,AUTHOR human
    class MARKER,GENERATOR,LINKER ai
    class BUS bus
    class KB kb
    class SOURCES stream
    class GATHERER,BINDER worker
```

## Actors

### Human Actors

| Actor | Flows | What they do |
|-------|-------|-------------|
| **Reader** | browse, beckon | Navigates resources and annotations. Clicks, hovers, scrolls. Consumes the knowledge base without modifying it. |
| **Analyst** | mark, browse, beckon, bind | Reads content, creates annotations (highlights, comments, assessments, tags), and resolves references to existing resources. The primary human intelligence in the system. |
| **Author** | yield, mark | Composes new resources manually (via the compose page) and annotates them. Produces content that the knowledge base records. |

All human actors interact through the **Human UI** — the browser, Envoy proxy, Next.js frontend, and Hono backend. The UI translates DOM interactions (clicks, selections, form submissions) into events on the bus.

```mermaid
graph TB
    HUMAN["Human Actor<br/>(Reader, Analyst, Author)"] -->|browser| PROXY

    subgraph ui ["Human UI"]
        PROXY["Envoy / ALB<br/>(route by path)"]
        FE["Frontend<br/>(Next.js + React)"]
        BE["Backend API<br/>(Hono + JWT)"]
        DB[("Users DB<br/>(PostgreSQL)")]

        PROXY -->|"auth, pages"| FE
        PROXY -->|"API calls"| BE
        FE -->|"session tokens"| BE
        BE --> DB
    end

    BE -->|events| BUS["Event Bus"]
    FE -->|events| BUS

    classDef actor fill:#4a90a4,stroke:#2c5f7a,stroke-width:2px,color:#fff
    classDef ui fill:#d4a827,stroke:#8b6914,stroke-width:2px,color:#000
    classDef bus fill:#e8a838,stroke:#b07818,stroke-width:3px,color:#000,font-weight:bold

    class HUMAN actor
    class PROXY,FE,BE,DB ui
    class BUS bus
```

### AI Actors

| Actor | Flows | What they do |
|-------|-------|-------------|
| **Marker Agent** | mark, browse, beckon | Scans documents and proposes annotations — highlights, assessments, comments, tags, and entity references. Produces the same W3C annotations that human analysts do. |
| **Generator Agent** | yield, gather | Assembles context around a reference annotation (gather), then synthesizes a new resource from it (yield). Creates content that the knowledge base records. |
| **Linker Agent** | bind, gather | Resolves unresolved references by searching for matching resources and linking them. Performs entity resolution and coreference — the binding of a mention to its referent. |

AI actors connect via the backend API (REST + JWT) or MCP protocol. They emit the same events as human actors. The knowledge base cannot distinguish a human-created annotation from an AI-created one — both are W3C annotations with a `creator` field that identifies the agent.

### Knowledge Base

The knowledge base is not an intelligent actor. It has no goals, preferences, or decisions. It listens to events on the bus and materializes durable state. It never initiates an event. Events flow *into* it. Reads flow *out of* it — via the **Gatherer** and **Binder**, which query KB stores in response to gather and bind events respectively. This asymmetry is deliberate — it means the knowledge base can be rebuilt from the event log at any time.

```mermaid
graph TB
    BUS["Event Bus"] -->|"mark, ..."| EVENTLOG
    BUS -->|"yield"| CONTENT
    CONTENT -->|"browse"| BUS
    BUS -->|"gather"| GATHERER["Gatherer"]
    BUS -->|"bind"| BINDER["Binder"]

    subgraph kb ["Knowledge Base"]
        subgraph sor ["System of Record"]
            EVENTLOG["Event Log<br/>(immutable append-only)"]
            CONTENT["Content Store<br/>(SHA-256 addressed, deduplicated)"]
        end
        VIEWS["Materialized Views<br/>(fast single-doc queries)"]
        GRAPH["Graph<br/>(eventually consistent)"]
        VECTORS["Vectors<br/>(planned)"]

        EVENTLOG -->|materialize| VIEWS
        EVENTLOG -->|project| GRAPH
        CONTENT -->|embed| VECTORS
    end

    GATHERER -->|query| VIEWS
    GATHERER -->|read| CONTENT
    GATHERER -->|traverse| GRAPH
    GATHERER -->|search| VECTORS

    BINDER -->|query| VIEWS
    BINDER -->|traverse| GRAPH
    BINDER -->|search| VECTORS

    classDef bus fill:#e8a838,stroke:#b07818,stroke-width:3px,color:#000,font-weight:bold
    classDef store fill:#8b6b9d,stroke:#6b4a7a,stroke-width:2px,color:#fff
    classDef planned fill:#8b6b9d,stroke:#6b4a7a,stroke-width:2px,color:#fff,stroke-dasharray: 5 5
    classDef worker fill:#5a9a6a,stroke:#3d6644,stroke-width:2px,color:#fff

    class BUS bus
    class EVENTLOG,VIEWS,CONTENT,GRAPH store
    class VECTORS planned
    class GATHERER,BINDER worker
```

| Store | Purpose | Access Pattern |
|-------|---------|---------------|
| **Event Log** | Immutable append-only log of all domain events | Append only, subscribe for real-time |
| **Materialized Views** | Denormalized projections for fast reads | Query by resource URI |
| **Content Store** | Content-addressed binary storage (documents, images, PDFs) | Write-once, read by SHA-256 checksum |
| **Graph** | Eventually consistent relationship projection for traversal queries (backlinks, entity networks) | Read-only projection from events |
| **Vectors** *(planned)* | Embedding vectors derived from content for semantic search | Read-only projection from content store |

### Gatherer

The Gatherer is the bridge between the event bus and the knowledge base for context assembly. When a Generator Agent or Linker Agent emits a **gather** event, the Gatherer receives it from the bus, queries the relevant KB stores (materialized views, content store, graph, vectors), and assembles the context needed for downstream work.

### Binder

The Binder is the bridge between the event bus and the knowledge base for entity resolution. When an Analyst or Linker Agent emits a **bind** event, the Binder receives it from the bus, searches the KB stores (materialized views, graph, vectors) for matching resources, and resolves references — linking a mention to its referent. The Binder does not need the content store directly; it works with metadata, relationships, and embeddings to find the right target.

The Gatherer and Binder are the only actors that read from KB stores directly. All other actors interact with the knowledge base exclusively through the event bus.

### Content Streams

Content streams are sources of new resources entering the system. They participate only in the **yield** flow:

- **Upload** — a human drags a file into the browser
- **API Ingestion** — an external system pushes content via REST
- **Web Fetch** — the system retrieves content from a URL

Each produces a `resource.created` event. After that, the resource is available for all other actors to annotate, browse, link, and generate from.

## Flows as Verbs

The six flows are verbs that actors perform. Each flow is a conversation between one or more intelligent actors and the knowledge base, mediated by the event bus:

| Flow | Verb | Who does it | What happens |
|------|------|-------------|-------------|
| **[Mark](flows/MARK.md)** | Annotate | Analyst, Author, Marker Agent | Create W3C annotations on resources |
| **[Browse](flows/BROWSE.md)** | Navigate | Reader, Analyst, Marker Agent | Route attention to panels, annotations, resources |
| **[Beckon](flows/BECKON.md)** | Focus | Reader, Analyst, Marker Agent | Coordinate which annotation has visual attention |
| **[Bind](flows/BIND.md)** | Link | Analyst, Linker Agent, Binder | Resolve references to concrete resources |
| **[Gather](flows/GATHER.md)** | Contextualize | Generator Agent, Linker Agent, Gatherer | Assemble surrounding context for downstream use |
| **[Yield](flows/YIELD.md)** | Create | Author, Generator Agent, Content Streams | Produce new resources in the knowledge base |

## Why This Matters

The actor model makes three things visible that the layered architecture obscures:

1. **Human and AI are peers.** They perform the same flows, produce the same events, and create the same W3C annotations. The system does not privilege one over the other. A future actor — a different AI model, a rule engine, a crowdsourcing pipeline — slots in by subscribing to and emitting events.

2. **The knowledge base is inert.** It records; it does not decide. All intelligence lives in the actors. This means the knowledge base can be simple, append-only, and rebuildable — properties that are hard to maintain when "smart" behavior leaks into the data layer.

3. **Flows are composable.** A Marker Agent does mark + browse + beckon. A Generator Agent does yield + gather. New actor types can mix flows freely. The bus doesn't care who emits an event or who consumes it — only that the event conforms to the [event map](../packages/core/src/event-map.ts).
