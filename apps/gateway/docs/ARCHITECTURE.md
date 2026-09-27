# Gateway Architecture

This document describes the architectural patterns and design principles that govern the Semiont gateway.

## Composition Root

**All long-lived state is created once at startup in [src/index.ts](../src/index.ts); routes construct nothing.**

Startup builds four things, and refuses rather than degrades when any is missing — and then refuses to listen unless its routes are exactly the spec's operations (below):

1. **Config** — `readGatewayConfig` ([src/config.ts](../src/config.ts)): one JSON document at `~/.semiontconfig`, a `GatewayConfig` from `specs/`, validated against the spec's schema. The launcher writes it resolved — the KB's committed name and domain, the port and public URL, the issuer, the Archivist's address, the signal plane, the log level — so the gateway neither parses TOML nor resolves or defaults anything.
2. **Identity** — two halves. `configureTrustedIssuer` ([src/identity/trusted-issuer.ts](../src/identity/trusted-issuer.ts)) names the issuer whose published keys verify every bearer this process accepts; people and service accounts alike obtain their tokens there, and the gateway keeps no account, no session and no row. `requireJwtSecret` ([src/auth/jwt.ts](../src/auth/jwt.ts)) checks the key ring the gateway signs its own two token kinds with — agent tokens minted at `POST /api/tokens/agent` and media tokens — the only credentials that originate here. The document's `kb.domain` — the KB's committed `[site] domain` — is the audience tokens must carry, the authority people and agents are named under, and the issuer of the tokens the gateway signs.
3. **Archivist access** — the document's `archivist` address and this process's own service account (`requireServiceAccount`, [src/boot-requirements.ts](../src/boot-requirements.ts)), resolved once into the `archivist` context value every proxying route uses. Checked at boot so a misconfigured record fails once, loudly, rather than on the first content read.
4. **EventBus + Signal Plane** — the per-process RxJS bus, composed with the fan-out driver by `compositionFor(eventBus, plane?)` ([src/signal/](../src/signal/)): plane plus the correlation ledger. A `signal.type` of `nats` seeds it with the NATS driver; `in-process` composes the in-process one. See [The Signal Plane](#the-signal-plane).

**The route table is the spec's.** Once every route is registered, and before `serve()`, `routeMismatches` ([src/spec-routes.ts](../src/spec-routes.ts)) compares `app.routes` with the operations in the OpenAPI document the build ships beside the entry point. A route the spec does not declare, a declared operation nothing serves, or middleware on a path the spec does not name stops the process, naming each. The conformance suite probes every operation the spec declares from outside; this is the half it cannot see.

Routes read `eventBus` and `archivist` from Hono context (auth middleware adds the caller's `principal`) and reach everything KB-shaped remotely. The gateway makes no bus request of its own: an upload, content bytes, a JSON-LD description and a replay are HTTP calls to the archivist through [src/lib/archivist.ts](../src/lib/archivist.ts), and every other domain read is a client's own bus request, which the gateway only relays:

```typescript
// The pipe: bytes proxied from the archivist
const { body, mediaType } = await getContent(c.get('archivist'), id);
```

Graph, vectors, embedding, inference, the event store, the working tree, and the job queue belong to other services. [package.json](../package.json) enforces the store half: `@semiont/graph`, `@semiont/vectors`, `@semiont/inference`, and `@semiont/event-sourcing` are not dependencies, so a route cannot import a store client at all. The conformance suite enforces the queue half: a `job:*` request gets no answer from the gateway.

## Process Split

The gateway is one process among eight service containers (see [CONTAINER-TOPOLOGY.md](../../../docs/system/CONTAINER-TOPOLOGY.md)). It hosts **no actors** and **no handlers**: the archivist runs the record actors (Stower, Browser, CloneTokenManager), the librarian the LLM-bound ones (Gatherer, Matcher), the smelter and weaver the vector and graph projections, and the dispatcher owns the job queue and answers every `job:*` command. What remains here is HTTP/SSE termination, identity (verification against the issuer; the agent and media tokens it signs), bus-frame validation and relay, the correlation ledger, and the content proxy. Every other service connects over the same bus the Browser uses; a sidecar can crash and restart without affecting the gateway or connected clients.

### Where the job queue went

It was the last non-routing work in this process, and it left with the dispatcher. `job:create` and its kin are frames the gateway validates and routes like any other; the dispatcher subscribes to them, answers them, and dials JetStream itself. The gateway's one remaining part in a claim is the `_roles` it stamps onto every emitted frame from the caller's token — set or cleared on every emit, never taken from the payload — which is what the dispatcher authorizes a `job:claim` by. See [apps/dispatcher](../../dispatcher/README.md).

## The Signal Plane

`src/signal/` is the hub's fan-out behind a driver interface ([interface.ts](../src/signal/interface.ts)) — the plane moves frames and honors reply addresses; it never inspects a payload or decides entitlement. Two drivers implement it, and the conformance suite runs the gateway on each:

- **in-process** ([in-process.ts](../src/signal/in-process.ts)) — the per-process EventBus; the permanent local default.
- **NATS** ([nats.ts](../src/signal/nats.ts)) — frames ride core subjects and are never stored; the ledger's tables are JetStream KV buckets on the same server, which also holds the dispatcher's queue. This driver is what lets the gateway run as N replicas.

Entitlement is gateway policy, kept above the seam in the **correlation ledger** ([ledger.ts](../src/signal/ledger.ts)): it records a claim at each request emit, decides who may see a reply, and retains replies for reconnect recovery. `compositionFor` ([composition.ts](../src/signal/composition.ts)) wires plane + ledger as one unit — a standing tap feeds the ledger from the plane. Claims, and the replies retained for reconnect recovery, live in tables every replica shares — JetStream KV buckets under NATS, so the broker must run with JetStream — and each replica keeps a projection of the claims; a replica that has not caught up with a claim reads the table rather than refusing the reply, so a replica that starts, restarts or lags still delivers to the claim's owner, and recovery answers from any replica, across restarts. The driver never learns the correlation vocabulary: the correlationId rides the frame's envelope, ferried unread, and a correlationId inside a payload is the caller's data and routes nothing. The gateway does not listen until its claims table is open. With the driver remote, startup flushes the plane before listening, so the ledger's standing tap and every early `/bus/subscribe` interest are registered with the broker before the first frame can be missed; shutdown drains it under a deadline for the same reason in reverse. Under a broker outage emits are refused with 503 — the NATS client discards whatever is published while it is disconnected, so the plane reports itself unavailable rather than accept a frame it would lose — and the driver retries forever; recovery is a broker restart, breadcrumbed `[signal BROKER-DOWN]`/`[signal BROKER-RECONNECTED]`.

## Domain Traffic Rides the Bus

Domain reads and commands have no per-route HTTP faces: clients emit bus operations (`POST /bus/emit`, replies over the SSE subscription) via the SDK, and the answering actors live in other containers — the archivist's Browser answers `browse:*`, the librarian's Matcher and Gatherer answer `bind:*` and `gather:*`, the dispatcher answers `job:*`. The gateway makes no bus request of its own: `GET /resources/:id/jsonld`, the linked-data description for machine clients arriving over plain HTTP, is read from the Archivist over HTTP like the bytes.

### The Content Plane

| Route | Behavior |
|-------|----------|
| `GET /resources/:id` | The pipe: stored bytes, verbatim, stored media type in `Content-Type`. The `Accept` header is never read — no negotiation, no transcoding — so byte fidelity holds on every response. A `Link: rel="describedby"` header points at the JSON-LD description. |
| `GET /resources/:id/jsonld` | The JSON-LD description (descriptor + annotations + inbound references), read from the archivist. |
| `GET /api/resources/:id` | Browser-friendly alias of the pipe; exists only as the `?token=` auth affordance for `<img>`, PDF.js, and download links. |
| `POST /resources` | Multipart upload, streamed untouched to the archivist, which stores the bytes and records the resource. |

The gateway holds no bytes — both directions stream through the archivist's HTTP byte surface.

### What Stays HTTP-Only

- **Bus bridge** — `POST /bus/emit`, `POST /bus/subscribe` (SSE): the transport every domain command and reply rides
- **Content plane** — the four routes above
- **Auth routes** — token verification against the trusted issuer's keys, and the agent and media
  tokens the gateway itself signs (orthogonal to knowledge domain)
- **Resource metadata** — `/.well-known/oauth-protected-resource`, naming this KB's issuer for clients that discover it
- **Health/Status** — infrastructure monitoring

## Calls to the Archivist

The Archivist holds the knowledge base's files and event log. Requests reach it two ways.

**HTTP, for bytes and a few reads of the record.** The gateway calls it on a client's behalf:

| Client calls the gateway | The gateway calls the Archivist |
|---|---|
| `POST /resources` | `POST /resources` with the multipart body unchanged, naming the caller in `Semiont-Principal` and `Semiont-Roles`: the archivist stores the bytes and records the resource |
| `GET /resources/:id`, `GET /api/resources/:id` | `GET /resources/:id/content`, streamed back unchanged |
| `GET /resources/:id/jsonld` | `GET /resources/:id/jsonld` |
| `POST /bus/subscribe` with `Last-Event-ID` | `GET /events/:resourceId?fromSequence=N` for the events the client missed |

The gateway authenticates with its own service account: a token from the knowledge base's identity provider carrying the `semiont-service` role. Browsers never reach the Archivist; their tokens lack that role.

The Librarian, the Smelter and the workers call `GET /resources/:id/content` directly, each with its own service account. Only the gateway's own calls pass through the gateway.

**The bus, for everything else.** The Archivist is a client of the gateway's `POST /bus/subscribe` and `POST /bus/emit`, so every command it handles and every `browse:*` read it answers passes through the gateway, under either signal driver. It never connects to NATS.

The Archivist's side of this, including what it means for a worker run outside the stack: [apps/archivist/README.md](../../archivist/README.md#how-requests-reach-it).

## Related Documentation

- [Dispatcher](../../dispatcher/README.md) - the job queue and the `job:*` handlers this process used to host
- [Jobs Package](../../../packages/jobs/) - `JobQueue`, its drivers, and the worker
- [Container Topology](../../../docs/system/CONTAINER-TOPOLOGY.md) - what runs where
- [AUTHENTICATION.md](AUTHENTICATION.md) - the identity plane

---

**Last Updated**: 2026-09-25
