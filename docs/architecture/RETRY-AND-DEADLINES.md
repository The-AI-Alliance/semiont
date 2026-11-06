# Retry and Deadlines

Every peer in a knowledge base reaches another over the network at boot, and every one of
those connects can find its dependency not yet listening. Two mechanisms answer that, and the
rule for choosing between them is which end knows what:

- **A deadline** bounds waiting. A Python service bounds a wait with `asyncio.timeout`. On
  expiry the wait is cancelled; at boot that reaches a main's catch-all, which exits so the
  container restart policy can try again.
- **A retry** repeats a request that failed for a reason worth repeating. `retryWithBackoff`
  takes the operation, a predicate that says which failures qualify, and a policy that says how
  long.

The two are one contract: a retry that outlives its caller's deadline stops when that deadline
fires, rather than being abandoned mid-flight.

`retryWithBackoff` is each SDK's, spelled as its language spells it. The `retry` module of
[`protocol/specs/src/client/surface.json`](../../protocol/specs/src/client/surface.json) says
where each SDK keeps it, and which SDK has yet to.

## The policies

A policy answers *how long until this specific peer is ready*. It is never shared between
peers that answer differently.

| policy | who waits | for what | budget |
|---|---|---|---|
| `STARTUP_FETCH_RETRY` | a TypeScript agent signing in (`agent-token.ts`, in `@semiont/http-transport`) | the issuer to grant its token, and the **gateway** to name it (`GET /api/users/me`) | 8 × 1s→8s ≈ 39s |
| `emitRetry`, in [`protocol/specs/src/client/timing.json`](../../protocol/specs/src/client/timing.json) | every SDK, for each emit | the **gateway** to accept one `/bus/emit` | the one `timing.json` states, once per credential: a renewed credential starts a fresh one |
| the catalog reader's, in `packages/python/service/src/semiont_service/catalog.py` | weaver, smelter | the **archivist** to subscribe | 17 × 1s→30s ≈ 361s |
| `EMBEDDING_PROVIDER_RETRY`, in `packages/python/vectors/src/semiont_vectors/_retry.py` | librarian, smelter | the **embedding provider** to serve a model | 12 × 1s→15s ≈ 120s |

Budgets above are the delays alone. Each attempt is separately bounded — by
`EMBED_ROUND_TRIP_SECONDS` (15s) for the provider, and by `timing.json`'s `emitTimeoutMs` for an
emit and `busRequestTimeoutMs` for a bus request — so a wall-clock ceiling is delays plus
attempts × that bound, and the embedding provider's worst case is ~300s. Without a per-attempt
bound an attempt count means nothing: a `fetch` with no signal can sit in TCP retransmit for
minutes.

Backoff is equal-jittered — each wait lands in `[cap/2, cap)` — so these are ceilings and the
expected wait is about three quarters of them. Jitter is not optional: these
are containers that boot together and retry against one gateway, and an identical schedule
re-converges N peers on the same instant.

**An emit's budget is per credential.** Every SDK retries each emit on its own under
`emitRetry`. A refused credential (a 401, or a 429 `refusal-rate`) is not retried: the SDK renews
it once and sends the emit again with the renewed one, which starts a fresh `emitRetry` budget,
its backoff begun again. So an emit spans at most two budgets, as
[TRANSPORT-HTTP.md § Emitting](../../protocol/contract/TRANSPORT-HTTP.md#emitting) states, and the
SDK conformance suite holds every SDK to it.

**The budgets chain.** A projector waits on the archivist, whose own start can take minutes.
The catalog reader's policy is sized by that, at about five and a half minutes in all, so that
a weaver or a smelter does not give up on an archivist still starting.

## Which failures qualify

A predicate narrows an error type, and a retry site passes exactly one. Each site knows which
failure it is waiting out; there is no general "is this retryable?", because a bad API key and
a bus refusal both answer no for different reasons.

| predicate | true for | lives in |
|---|---|---|
| an emit's, from the `boot` rule | what the rule accepts of a `POST`: no answer, or a status that says the gateway will recover | every SDK |
| `_not_ready` | the model is not pulled, **or** the provider is not listening | `semiont_vectors` (`_dimensions.py`) |

What counts as worth another attempt is the same in every language: the rules are
[`protocol/specs/src/retry/cases.json`](../../protocol/specs/src/retry/cases.json), and each implementation runs
them.

`_not_ready` is the one composition, and it is deliberate: at boot both failures are the same
wait with the same consequence — a flapping archivist strands the worker either way.

The exclusions carry as much weight as the inclusions. An emit's predicate refuses every other
HTTP-level failure: a 401 means the gateway is up and refused the credential, which is renewed,
never retried. The catalog reader's predicate takes `bus.peer-unavailable` and refuses
`bus.unsubscribed`, which sounds identical and means the opposite end: *this* transport is not
subscribed to the reply channel, a local misconfiguration no waiting fixes.

## Where a retry belongs

A request travels four layers, and only two of them retry.

| layer | retries | why |
|---|---|---|
| `/bus/emit` POST | **yes** | transport refusals: the gateway is up and asking us to wait |
| `Bus.request` | **no** | cannot know whether the operation is idempotent |
| the caller of `Bus.request` | **yes** | knows what it asked for |
| the boot pass | **no** | a pass retry re-sends every request that already succeeded |

`Bus.request`'s operations include both `browse:resource-requested` and
`yield:clone-resource-requested`. A read is idempotent; a create is not, and retrying one whose
reply timed out double-writes. Only the caller can tell those apart, which is why
the catalog reader asks again for a page nobody answered, and no write path retries at all.

The boot pass sits above everything and does one thing: record the phase, log, and **not**
exit. A repair pass that fails leaves a store behind; it does not leave the projector dead.

**The gateway's reads of the Archivist** are sent once more, at once, when they get no answer: a
read written to a pooled connection just as the Archivist closes it fails without one. It is
reqwest's own retry on the client the gateway reads the Archivist with. A status is an answer and
is not asked again; a read whose connection was not taken within its wait is not sent again, since
the Archivist cannot be reached and a second attempt would wait as long again; a read's answer
begins within `connectSeconds` and `readSeconds` together of its first send, its retry included,
and a read whose answer did not is not sent again; and an upload is never sent again: its body is
streamed. How long the gateway waits is the Archivist's document's to say (its `x-semiont-limits`),
as it is for the Python services that read it ([the gateway's
calls](../../images/gateway/docs/ARCHITECTURE.md#calls-to-the-archivist)), and those waits end
inside a client's own deadline on its request, `httpRequestTimeoutMs`.

## What deliberately does not retry

**Graph, vector store and embedding provider connects** take a deadline instead —
one minute (`asyncio.timeout`) in the librarian's start, and the same minute in the weaver's and
the smelter's ([SMELTER.md](../../protocol/contract/SMELTER.md#boot)). These are one-shot connects with no transient class worth naming, and an
unbounded await leaves a container hung where a restart-on-exit policy can only rescue a process
that exits.

**The SSE reconnect** is the one unbounded loop, with its own ladder capped at 60s. A dropped
subscription must always come back; every other site is a request with a caller waiting.

## Constants live with their callers

The `retry` module holds the mechanism, in each SDK that has one. Policies, deadlines and provider-specific predicates live in
the package that owns the question, and that placement is load-bearing: an embedding path that
borrows `STARTUP_FETCH_RETRY` — sized for *until the gateway starts listening* — expires
waiting for a model download and kills the services that embed on every first boot.
`STARTUP_FETCH_RETRY` is the one hand-written policy in TypeScript's core. `emitRetry` is
hand-written in no SDK: it is client timing, and every SDK takes it from
[`protocol/specs/src/client/timing.json`](../../protocol/specs/src/client/timing.json).

## See also

- [CONTAINER-TOPOLOGY.md](../operator/CONTAINER-TOPOLOGY.md) — which peer runs where, and what depends on what.
- [KNOWLEDGE-SYSTEM.md](KNOWLEDGE-SYSTEM.md) — the actors behind these channels.
