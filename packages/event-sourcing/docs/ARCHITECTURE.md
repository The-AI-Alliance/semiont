# Event Sourcing Architecture

## Component Architecture

```mermaid
graph TB
    subgraph "EventStore (Coordinator)"
        ES[EventStore<br/>Enforces write invariants]
    end

    subgraph "Primary Components"
        LOG[EventLog<br/>Persistence]
        BUS[EventBus<br/>Pub/Sub]
        VIEWS[ViewManager<br/>Materialization]
    end

    subgraph "Internal Modules"
        STORAGE[EventStorage<br/>JSONL + Sharding]
        SUBS[EventSubscriptions<br/>Real-time notifications]
        MAT[ViewMaterializer<br/>Event → View transform]
        QUERY[EventQuery<br/>Read + Filter]
        VALID[EventValidator<br/>Chain integrity]
    end

    subgraph "Storage Backends"
        JSONL[(JSONL Files<br/>Event Log)]
        VIEWDB[(ViewStorage<br/>Materialized Views)]
    end

    ES -->|1. Persist| LOG
    ES -->|2. Materialize| VIEWS
    ES -->|3. Notify| BUS

    LOG --> STORAGE
    LOG -.->|expose for queries| QUERY
    LOG -.->|expose for validation| VALID

    BUS --> SUBS

    VIEWS --> MAT

    STORAGE -->|append/read| JSONL
    MAT -->|save/get| VIEWDB

    classDef coordinator fill:#d4a827,stroke:#8b6914,stroke-width:3px,color:#000
    classDef primary fill:#5a9a6a,stroke:#3d6644,stroke-width:2px,color:#fff
    classDef internal fill:#8b6b9d,stroke:#6b4a7a,stroke-width:2px,color:#fff
    classDef storage fill:#4a90a4,stroke:#2c5f7a,stroke-width:2px,color:#fff

    class ES coordinator
    class LOG,BUS,VIEWS primary
    class STORAGE,SUBS,MAT,QUERY,VALID internal
    class JSONL,VIEWDB storage
```

## Core Concepts

### Immutable Event Log

All changes are recorded as events in an append-only JSONL log:

- Events are NEVER modified or deleted
- Each event contains `prevEventHash` linking to previous event's checksum
- Complete audit trail for all system changes
- Events can be replayed to rebuild state at any point

### Materialized Views

Current state is built from events and stored for fast queries:

- Views optimized for specific query patterns
- Can be rebuilt at any time from the event log
- Updated incrementally as new events arrive
- Stored via ViewStorage abstraction

### Pub/Sub Notifications

Real-time event notifications via publish-subscribe pattern:

- Resource-scoped subscriptions (per-resource callbacks)
- Global subscriptions (system-wide events)
- Fire-and-forget notification pattern (non-blocking)
- Powers Server-Sent Events (SSE) for browser clients

## Write Path Coordination

The EventStore enforces a strict write invariant:

1. **Persist** - Event written to immutable log
2. **Materialize** - View updated with new event
3. **Notify** - Subscribers notified of change

This ensures consistency across all components.

## Event Chain Validation

Events form a hash chain for integrity:

- Each event includes SHA-256 of previous event
- Chain can be validated to detect tampering
- Sequence numbers ensure no events are missing
- Per-resource chains for isolation

## JSONL Storage Format

Events stored as JSON Lines (one JSON object per line):

```jsonl
{"event":{"id":"evt-abc123","type":"resource.created","userId":"user-456","resourceId":"doc-789","timestamp":"2025-01-15T10:30:00Z","payload":{}},"metadata":{"sequenceNumber":1,"streamPosition":0,"timestamp":"2025-01-15T10:30:00Z","checksum":"sha256abc"}}
{"event":{"id":"evt-def456","type":"annotation.added","userId":"user-456","resourceId":"doc-789","timestamp":"2025-01-15T10:31:00Z","payload":{}},"metadata":{"sequenceNumber":2,"streamPosition":1,"timestamp":"2025-01-15T10:31:00Z","prevEventHash":"sha256abc","checksum":"sha256def"}}
```

Benefits:
- Human-readable
- Streamable
- Append-only
- Tool-friendly (grep, jq, etc.)