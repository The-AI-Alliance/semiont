# Package Architecture

Semiont is a monorepo with two workspaces: the npm packages, and the Rust crates. Neither depends on the other. Both are built against [`specs/`](../../specs/src/openapi.json), the protocol each implements from its side.

For the per-package descriptions and npm metadata, see **[../../packages/README.md](../../packages/README.md)** — alphabetized table with one-line descriptions of every published `@semiont/*` package.

## The npm packages

Workspace packages are organized in layers from low-level primitives to application logic; the Browser (`apps/browser`) sits on top.

```mermaid
graph BT
    %% Layer 5: Application
    browser["apps/browser<br/><i>Vite + React SPA</i>"]

    %% Layer 4: Application logic
    meaning["@semiont/make-meaning<br/><i>The knowledge-system actors and<br/>four services' entry points</i>"]
    react["@semiont/react-ui<br/><i>React components & hooks</i>"]
    mcp["@semiont/mcp-server<br/><i>Model Context Protocol server</i>"]

    %% Layer 3: Workers
    jobs["@semiont/jobs<br/><i>Job worker + its entry point</i>"]

    %% Layer 2: SDK + domain storage
    sdk["@semiont/sdk<br/><i>SemiontClient + namespaces + session<br/>state units, cache</i>"]
    graph_pkg["@semiont/graph<br/><i>Graph DB abstraction</i>"]
    event["@semiont/event-sourcing<br/><i>Event store & materialized views</i>"]

    %% Layer 1: Wire + primitives
    api["@semiont/http-transport<br/><i>HttpTransport, HttpContentTransport</i>"]
    content["@semiont/content<br/><i>Working-tree storage, text extraction</i>"]
    vectors["@semiont/vectors<br/><i>Vector store & embeddings</i>"]
    ontology["@semiont/ontology<br/><i>Entity schemas & W3C vocab</i>"]
    inference["@semiont/inference<br/><i>LLM abstraction</i>"]

    %% Layer 0: Foundation
    core["@semiont/core<br/><i>OpenAPI types, typed ids,<br/>bus protocol, config loaders</i>"]
    obs["@semiont/observability<br/><i>OTel helpers, logging</i>"]

    browser --> react
    browser --> sdk
    browser --> api

    meaning --> jobs
    meaning --> sdk
    meaning --> event
    meaning --> graph_pkg
    meaning --> api
    meaning --> content
    meaning --> vectors
    meaning --> ontology
    meaning --> inference
    meaning --> obs
    meaning --> core
    react --> sdk
    react --> api
    react --> core
    mcp --> sdk
    mcp --> api

    jobs --> sdk
    jobs --> event
    jobs --> api
    jobs --> content
    jobs --> inference
    jobs --> obs
    jobs --> core

    sdk --> api
    sdk --> core
    graph_pkg --> api
    graph_pkg --> ontology
    graph_pkg --> core
    event --> api
    event --> content
    event --> obs
    event --> core

    api --> obs
    api --> core
    content --> obs
    content --> core
    vectors --> core
    ontology --> core
    inference --> obs
    inference --> core

    obs --> core

    classDef layer0 fill:#e1f5fe,stroke:#01579b,stroke-width:3px
    classDef layer1 fill:#f3e5f5,stroke:#4a148c,stroke-width:2px
    classDef layer2 fill:#fff3e0,stroke:#e65100,stroke-width:2px
    classDef layer3 fill:#ffd180,stroke:#e65100,stroke-width:2px
    classDef layer4 fill:#ffe0b2,stroke:#e65100,stroke-width:3px
    classDef layer5 fill:#e8f5e9,stroke:#1b5e20,stroke-width:3px

    class core,obs layer0
    class api,content,vectors,ontology,inference layer1
    class sdk,event,graph_pkg layer2
    class jobs layer3
    class meaning,react,mcp layer4
    class browser layer5
```

Each edge is an entry in that package's `package.json` `dependencies`.

## The Rust crates

```mermaid
graph BT
    gateway["apps/gateway<br/><i>semiont-gateway</i>"]
    dispatcher["apps/dispatcher<br/><i>semiont-dispatcher</i>"]

    rcore["semiont-core<br/><i>What the Rust services share</i>"]
    robs["semiont-observability<br/><i>Telemetry export, log lines</i>"]
    rserve["semiont-http-service<br/><i>Serving HTTP, verifying the issuer's tokens</i>"]
    rhttp["semiont-http-transport<br/><i>The transport over a gateway, sign-in</i>"]
    rtel["semiont-telemetry<br/><i>Spans and counts, no exporter</i>"]
    rsdk["semiont<br/><i>The Rust SDK</i>"]
    codegen["semiont-codegen<br/><i>Build-time generation from specs/</i>"]

    gateway --> rcore
    gateway --> robs
    gateway --> rserve
    gateway --> rhttp
    gateway --> rtel
    gateway --> rsdk
    dispatcher --> rcore
    dispatcher --> robs
    dispatcher --> rhttp
    dispatcher --> rtel
    dispatcher --> rsdk

    rcore --> robs
    rcore --> rsdk
    robs --> rtel
    robs --> rsdk
    rhttp --> rtel
    rhttp --> rsdk
    rtel --> rsdk

    rsdk -.->|build| codegen
    rcore -.->|build| codegen

    classDef app fill:#e8f5e9,stroke:#1b5e20,stroke-width:3px
    classDef internal fill:#fff3e0,stroke:#e65100,stroke-width:2px
    classDef published fill:#e1f5fe,stroke:#01579b,stroke-width:3px

    class gateway,dispatcher app
    class rcore,robs,rserve internal
    class rhttp,rtel,rsdk,codegen published
```

Four crates are published to crates.io: `semiont`, `semiont-http-transport`, `semiont-telemetry` and `semiont-codegen`. `semiont-core`, `semiont-observability` and `semiont-http-service` are the services' own. The dispatcher also has two crates of its own beside its binary, for its handlers and its JetStream queue. The Archivist has two as well, for its record and its staging drivers.

## The Python package

`packages/sdk-python` is one distribution, `semiont`: the client, its transport over a gateway, sign-in, and telemetry with no exporter, which Rust keeps in four crates. It depends on `httpx`, `pydantic` and `opentelemetry-api`, and on nothing else in this repository. What it holds of `specs/` is generated, committed and held by drift gates.

## What each service image runs

| Image | Runs | From |
|---|---|---|
| `semiont-librarian` | `librarian-main` | `@semiont/make-meaning` |
| `semiont-smelter` | `smelter-main` | `@semiont/make-meaning` |
| `semiont-weaver` | `weaver-main` | `@semiont/make-meaning` |
| `semiont-worker` | `worker-main` | `@semiont/jobs` |
| `semiont-browser` | the built SPA | `apps/browser` |
| `semiont-gateway` | a Rust binary | `apps/gateway` |
| `semiont-archivist` | a Rust binary | `apps/archivist` |
| `semiont-dispatcher` | a Rust binary | `apps/dispatcher` |

## Architectural principles

1. **One composition root per process.** Each service's entry point builds what that process needs and nothing else.

2. **Strict API boundary.** `apps/browser` never imports a service's package. Its only `@semiont/*` imports are `@semiont/sdk`, `@semiont/http-transport` and `@semiont/react-ui` — every interaction with a knowledge base goes through the SDK over `HttpTransport`.

3. **Layered dependencies.** A package depends only on packages in lower layers. No circular dependencies.

4. **The spec is the boundary between languages.** No crate depends on an npm package, and no npm package on a crate. What they agree on is in `specs/`, and each side generates its types from it.

5. **Platform independence.** Foundation packages work in both browser and Node.js. Infrastructure packages (content, event-sourcing, graph, inference, jobs, make-meaning) are Node-only.

## See also

- **[../../packages/README.md](../../packages/README.md)** — alphabetized package catalog with one-line descriptions and npm links.
- **[KNOWLEDGE-SYSTEM.md](KNOWLEDGE-SYSTEM.md)** — what runs *inside* `@semiont/make-meaning` (the seven KB actors).
- **[CONTAINER-TOPOLOGY.md](../operator/CONTAINER-TOPOLOGY.md)** — how the service images fit together in a running stack.
