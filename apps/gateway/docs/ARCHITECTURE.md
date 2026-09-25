# Gateway Architecture

This document describes the architectural patterns and design principles that govern the Semiont gateway.

## Composition Root

**All long-lived state is created once at startup in [src/index.ts](../src/index.ts); routes construct nothing.**

Startup builds four things, and refuses rather than degrades when any is missing:

1. **Config** — `loadEnvironmentConfig(null)`. No KB root: the gateway mounts no knowledge-base tree. Everything it needs — the KB's committed settings, the launcher-staged `[kb]` identity, the archivist address — arrives in the per-service config mounted at `~/.semiontconfig`.
2. **Identity** — two halves. `configureTrustedIssuer` ([src/identity/trusted-issuer.ts](../src/identity/trusted-issuer.ts)) names the issuer whose published keys verify every bearer this process accepts; people and service accounts alike obtain their tokens there, and the gateway keeps no account, no session and no row. `requireJwtSecret` ([src/auth/jwt.ts](../src/auth/jwt.ts)) checks the key ring the gateway signs its own two token kinds with — agent tokens minted at `POST /api/tokens/agent` and media tokens — the only credentials that originate here. A KB-identity check runs beside them: the launcher-staged `[kb] domain` and the `site.domain` agent DIDs are minted from must agree.
3. **Archivist access** — `requireArchivistAccess` ([src/boot-requirements.ts](../src/boot-requirements.ts)): the address of the record and this process's own service-account credential for reaching it. Checked at boot so a misconfigured record fails once, loudly, rather than on the first content read.
4. **EventBus + Signal Plane** — the per-process RxJS bus, composed with the fan-out driver by `compositionFor(eventBus, plane?)` ([src/signal/](../src/signal/)): plane plus the correlation ledger. `[signal] type = "nats"` seeds it with the NATS driver; absent, it lazily composes the in-process driver. See [The Signal Plane](#the-signal-plane).

Routes read `config` and `eventBus` from Hono context (auth middleware adds the caller's `principal`) and reach everything KB-shaped remotely — content bytes through [src/lib/archivist.ts](../src/lib/archivist.ts), domain reads over the bus:

```typescript
// The pipe: bytes proxied from the archivist
const { body, mediaType } = await getContent(c.get('config'), id);

// A domain read: one bus round-trip, answered in another container
const response = await busRequest(
  requestPrimitiveFor(c.get('eventBus')),
  'browse:resource-requested', { resourceId: resourceId(id) },
);
```

Graph, vectors, embedding, inference, the event store, the working tree, and the job queue belong to other services. [package.json](../package.json) enforces the store half: `@semiont/graph`, `@semiont/vectors`, `@semiont/inference`, and `@semiont/event-sourcing` are not dependencies, so a route cannot import a store client at all. A census test enforces the queue half: no gateway code references a `job:*` handler.

## Process Split

The gateway is one process among eight service containers (see [CONTAINER-TOPOLOGY.md](../../../docs/system/CONTAINER-TOPOLOGY.md)). It hosts **no actors** and **no handlers**: the archivist runs the record actors (Stower, Browser, CloneTokenManager), the librarian the LLM-bound ones (Gatherer, Matcher), the smelter and weaver the vector and graph projections, and the dispatcher owns the job queue and answers every `job:*` command. What remains here is HTTP/SSE termination, identity (verification against the issuer; the agent and media tokens it signs), bus-frame validation and relay, the correlation ledger, and the content proxy. Every other service connects over the same bus the Browser uses; a sidecar can crash and restart without affecting the gateway or connected clients.

### Where the job queue went

It was the last non-routing work in this process, and it left with the dispatcher. `job:create` and its kin are frames the gateway validates and routes like any other; the dispatcher subscribes to them, answers them, and dials JetStream itself. The gateway's one remaining part in a claim is the `_roles` it stamps onto every emitted frame from the caller's token — set or cleared on every emit, never taken from the payload — which is what the dispatcher authorizes a `job:claim` by. See [apps/dispatcher](../../dispatcher/README.md).

## The Signal Plane

`src/signal/` is the hub's fan-out behind a driver interface ([interface.ts](../src/signal/interface.ts)) — the plane moves frames and honors reply addresses; it never inspects a payload or decides entitlement. Two drivers implement it, certified by one conformance suite:

- **in-process** ([in-process.ts](../src/signal/in-process.ts)) — the per-process EventBus; the permanent local default.
- **NATS** ([nats.ts](../src/signal/nats.ts)) — core subjects only, never JetStream (signals are not a record; JetStream on the same server is the dispatcher's queue). This driver is what lets the gateway run as N replicas.

Entitlement is gateway policy, kept above the seam in the **correlation ledger** ([ledger.ts](../src/signal/ledger.ts)): it records a claim at each request emit, decides who may see a reply, and retains replies for reconnect recovery. `compositionFor` ([composition.ts](../src/signal/composition.ts)) wires plane + ledger as one unit — a standing tap feeds the ledger from the plane. Claims, and the replies retained for reconnect recovery, live in tables every replica shares — JetStream KV buckets under NATS, so the broker must run with JetStream — and each replica keeps a projection of the claims; a replica that has not caught up with a claim reads the table rather than refusing the reply, so a replica that starts, restarts or lags still delivers to the claim's owner, and recovery answers from any replica, across restarts (the driver never learns the correlation vocabulary — that census is enforced). The gateway does not listen until its claims table is open. With the driver remote, startup flushes the plane before listening, so the ledger's standing tap and every early `/bus/subscribe` interest are registered with the broker before the first frame can be missed; shutdown drains it under a deadline for the same reason in reverse. Under a broker outage emits fail and the driver retries forever; recovery is a broker restart, breadcrumbed `[signal BROKER-DOWN]`/`[signal BROKER-RECONNECTED]`.

## Domain Traffic Rides the Bus

Domain reads and commands have no per-route HTTP faces: clients emit bus operations (`POST /bus/emit`, replies over the SSE subscription) via the SDK, and the answering actors live in other containers — the archivist's Browser answers `browse:*`, the librarian's Matcher and Gatherer answer `bind:*` and `gather:*`, the dispatcher answers `job:*`. The one delegating HTTP route left is `GET /resources/:id/jsonld`, which wraps `browse:resource-requested` in core's `busRequest` over the gateway's plane primitive, for machine clients arriving over plain HTTP.

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
- **Auth routes** — token verification against the trusted issuer's keys, and the agent and media
  tokens the gateway itself signs (orthogonal to knowledge domain)
- **Resource metadata** — `/.well-known/oauth-protected-resource`, naming this KB's issuer for clients that discover it
- **Health/Status** — infrastructure monitoring

## Related Documentation

- [Dispatcher](../../dispatcher/README.md) - the job queue and the `job:*` handlers this process used to host
- [Jobs Package](../../../packages/jobs/) - `JobQueue`, its drivers, and the worker
- [Container Topology](../../../docs/system/CONTAINER-TOPOLOGY.md) - what runs where
- [AUTHENTICATION.md](AUTHENTICATION.md) - the identity plane

---

**Last Updated**: 2026-09-21
