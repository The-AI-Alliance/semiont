# Gateway Architecture

This document describes the architectural patterns and design principles that govern the Semiont gateway.

## Composition Root

**All long-lived state is created once at startup in [src/index.ts](../src/index.ts); routes construct nothing.**

Startup builds five things:

1. **Config** — `loadEnvironmentConfig(null)`. No KB root: the gateway mounts no knowledge-base tree. Everything it needs — the KB's committed settings, the launcher-staged `[kb]` identity, the archivist address — arrives in the per-service config mounted at `~/.semiontconfig`.
2. **EventBus** — the per-process RxJS bus. It is also the in-process *driver* of the Signal Plane (below); `POST /bus/emit` and the SSE subscription reach the other containers through the selected driver, which is this bus by default.
3. **Signal Plane** — `compositionFor(eventBus, plane?)` ([src/signal/](../src/signal/)): plane (the fan-out driver) plus the correlation ledger. `[signal] type = "nats"` seeds it with the NATS driver and installs the handler bridge; absent, it lazily composes the in-process driver. See [The Signal Plane](#the-signal-plane).
4. **Make-meaning slice** — `startMakeMeaningGateway(state, config, eventBus, logger)` returns `{ jobQueue, state, stop }`: the job queue (driver by `[jobs]`) plus the gateway's bus-handler subset (the `job:*` command channels and the `bind:update-body` relay). No knowledge system, no stores, no actors. It takes a `SemiontState` — name plus state-mount paths, not a `SemiontProject` — so the type itself guarantees this process cannot reach a KB tree.
5. **Identity** — `JWTService` and the PostgreSQL connection ([src/db.ts](../src/db.ts)), the one datastore the gateway owns.

Routes read `config` and `eventBus` from Hono context (auth middleware adds `user` and `principalDid`) and reach everything KB-shaped remotely — content bytes through [src/lib/archivist.ts](../src/lib/archivist.ts), domain reads over the bus:

```typescript
// The pipe: bytes proxied from the archivist
const { body, mediaType } = await getContent(c.get('config'), id);

// A domain read: one bus round-trip, answered in another container
const response = await eventBusRequest(
  c.get('eventBus'),
  'browse:resource-requested', { correlationId, resourceId: resourceId(id) },
  'browse:resource-result', 'browse:resource-failed',
);
```

Graph, vectors, embedding, inference, the event store, and the working tree belong to other services. [package.json](../package.json) enforces this: `@semiont/graph`, `@semiont/vectors`, `@semiont/inference`, and `@semiont/event-sourcing` are not dependencies, so a route cannot import a store client at all.

## Process Split

The gateway is one process among seven service containers (see [CONTAINER-TOPOLOGY.md](../../../docs/system/CONTAINER-TOPOLOGY.md)). It hosts **no actors**: the archivist runs the record actors (Stower, Browser, CloneTokenManager), the librarian the LLM-bound ones (Gatherer, Matcher), and the smelter and weaver run the vector and graph projections. What remains here is HTTP/SSE termination, identity (PostgreSQL, JWT), bus-frame validation and relay, reply retention, the job queue, and the content proxy. Every other service connects over the same bus the Browser uses; a sidecar can crash and restart without affecting the gateway or connected clients.

### Job Queue

The job queue sits behind a `JobQueue` interface with two drivers, selected by `[jobs]`: `fs` (the launcher-mounted filesystem queue, the local default) and `jetstream` (NATS JetStream — streams and KV on the shared `messaging` daemon, required when the gateway runs as multiple replicas). Jobs are created here, announced on `job:queued`, claimed via the `job:claim` handler (which refuses non-pending jobs, so exactly one worker wins), and completed by events emitted back on the bus. Workers are stateless with respect to the KB.

## The Signal Plane

`src/signal/` is the hub's fan-out behind a driver interface ([interface.ts](../src/signal/interface.ts)) — the plane moves frames and honors reply addresses; it never inspects a payload or decides entitlement. Two drivers implement it, certified by one conformance suite:

- **in-process** ([in-process.ts](../src/signal/in-process.ts)) — the per-process EventBus; the permanent local default.
- **NATS** ([nats.ts](../src/signal/nats.ts)) — core subjects only, never JetStream (signals are not a record); the mapping lives once here and is boundary-gated. This driver is what lets the gateway run as N replicas.

Entitlement is gateway policy, kept above the seam in the **correlation ledger** ([ledger.ts](../src/signal/ledger.ts)): it records a claim at each request emit, decides who may see a reply, and retains replies for reconnect recovery. `compositionFor` ([composition.ts](../src/signal/composition.ts)) wires plane + ledger as one unit — a standing tap feeds the ledger from the plane, and under N replicas each claim is announced to a shared address so every replica's ledger converges (the driver never learns the correlation vocabulary — that census is enforced). When the driver is remote, `bridgeGatewayHandlers` ([bridge.ts](../src/signal/bridge.ts)) reconnects the gateway-resident handlers to the plane, one queue group so each command runs on exactly one replica. Under a broker outage emits fail and the driver retries forever; recovery is a broker restart, breadcrumbed `[signal BROKER-DOWN]`/`[signal BROKER-RECONNECTED]`.

## Domain Traffic Rides the Bus

Domain reads and commands have no per-route HTTP faces: clients emit bus operations (`POST /bus/emit`, replies over the SSE subscription) via the SDK, and the answering actors live in other containers — the archivist's Browser answers `browse:*`, the librarian's Matcher and Gatherer answer `bind:*` and `gather:*`. The one delegating HTTP route left is `GET /resources/:id/jsonld`, which wraps `browse:resource-requested` via the `eventBusRequest()` helper (`src/utils/event-bus-request.ts`) for machine clients arriving over plain HTTP.

### The Content Plane

| Route | Behavior |
|-------|----------|
| `GET /resources/:id` | The pipe: stored bytes, verbatim, stored media type in `Content-Type`. The `Accept` header is never read — no negotiation, no transcoding — so byte fidelity holds on every response. A `Link: rel="describedby"` header points at the JSON-LD description. |
| `GET /resources/:id/jsonld` | The JSON-LD description (descriptor + annotations + inbound references), via the bus. |
| `GET /api/resources/:id` | Browser-friendly alias of the pipe; exists only as the `?token=` auth affordance for `<img>`, PDF.js, and download links. |
| `POST /resources` | Multipart upload: bytes stream to the archivist (`PUT /content/:storageUri`), then the creation event rides the bus. |

The gateway holds no bytes — both directions stream through the archivist's HTTP byte surface.

### What Stays HTTP-Only

- **Bus bridge** — `POST /bus/emit`, `POST /bus/subscribe` (SSE): the transport every domain command and reply rides
- **Content plane** — the four routes above
- **Auth routes** — PostgreSQL/Prisma, JWT, OAuth (orthogonal to knowledge domain)
- **Admin routes** — PostgreSQL/Prisma (orthogonal to knowledge domain)
- **Health/Status** — infrastructure monitoring

## Related Documentation

- [Make-Meaning Package](../../../packages/make-meaning/) - `startMakeMeaningGateway` and the bus handlers
- [Jobs Package](../../../packages/jobs/) - `JobQueue` implementation and the worker pool
- [Container Topology](../../../docs/system/CONTAINER-TOPOLOGY.md) - what runs where
- [AUTHENTICATION.md](AUTHENTICATION.md) - the identity plane

---

**Last Updated**: 2026-09-15
